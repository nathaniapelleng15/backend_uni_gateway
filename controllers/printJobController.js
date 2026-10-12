const crypto = require('crypto');
const printJobModel = require('../models/printJobModel');
const sessionModel = require('../models/sessionModel');
const { sendKioskCommand, isKioskConnected, broadcastToAdmin } = require('../utils/socketServer');
const { schedulePrintJobTimeout, clearPrintJobTimeout } = require('../utils/printJobLifecycle');
const { normalizePrintRequest, PrintValidationError } = require('../utils/printValidation');

function samePrintRequest(job, request) {
  return job.image_url === request.image_url &&
    Number(job.copies) === request.copies &&
    job.paper_size === request.paper_size &&
    job.orientation === request.orientation;
}

function responseData(job) {
  return {
    job_id: job.job_id,
    session_code: job.session_code,
    status: job.status,
    copies: Number(job.copies),
  };
}

function createPrintJobController(overrides = {}) {
  const deps = {
    printJobModel,
    sessionModel,
    sendKioskCommand,
    isKioskConnected,
    schedulePrintJobTimeout,
    clearPrintJobTimeout,
    broadcastToAdmin,
    ...overrides,
  };

  return {
    createPrintJob: async (req, res, next) => {
      try {
        let request;
        try {
          request = normalizePrintRequest(req.body);
        } catch (error) {
          if (error instanceof PrintValidationError) {
            return res.status(error.statusCode).json({
              success: false,
              message: error.message,
              error_code: error.code,
            });
          }
          throw error;
        }

        const sessionCode = req.params.session_code;
        const kiosk = req.kiosk;
        const session = await deps.sessionModel.findByCodeAndKiosk(sessionCode, kiosk.id);
        if (!session) {
          return res.status(404).json({
            success: false,
            message: 'Session not found or does not belong to this kiosk.',
            error_code: 'SESSION_NOT_FOUND',
          });
        }

        if (session.package_type === 'digital') {
          return res.status(403).json({ success: false, message: 'Paket Digital tidak termasuk cetak foto.', error_code: 'PRINT_NOT_INCLUDED' });
        }

        if (session.payment_status !== 'verified') {
          return res.status(403).json({
            success: false,
            message: 'Sesi belum dibayar atau pembayaran belum terverifikasi.',
            error_code: 'PAYMENT_REQUIRED',
          });
        }

        const sessionIdentifier = session.session_code || session.id || sessionCode;
        const existing = await deps.printJobModel.findByIdempotencyKey(kiosk.id, request.idempotency_key);
        if (existing) {
          if (!samePrintRequest(existing, request) || existing.session_code !== sessionIdentifier) {
            return res.status(409).json({
              success: false,
              message: 'idempotency_key has already been used for a different print request.',
              error_code: 'IDEMPOTENCY_CONFLICT',
            });
          }
          return res.status(202).json({
            success: true,
            message: 'Print job already queued.',
            data: responseData(existing),
          });
        }

        const jobInput = {
          job_id: crypto.randomUUID(),
          kiosk_id: kiosk.id,
          session_id: String(session.id || sessionIdentifier),
          session_code: String(sessionIdentifier),
          ...request,
        };

        let job;
        try {
          job = await deps.printJobModel.create(jobInput);
        } catch (error) {
          // A concurrent request may have won the unique idempotency key race.
          if (error.code === 'ER_DUP_ENTRY' && request.idempotency_key) {
            const duplicate = await deps.printJobModel.findByIdempotencyKey(kiosk.id, request.idempotency_key);
            if (duplicate && samePrintRequest(duplicate, request) && duplicate.session_code === sessionIdentifier) {
              return res.status(202).json({ success: true, message: 'Print job already queued.', data: responseData(duplicate) });
            }
            return res.status(409).json({ success: false, message: 'idempotency_key has already been used.', error_code: 'IDEMPOTENCY_CONFLICT' });
          }
          throw error;
        }

        const online = deps.isKioskConnected(kiosk.id);
        if (!online) {
          const failed = await deps.printJobModel.markFailedIfPending(
            job.job_id, kiosk.id, 'KIOSK_OFFLINE', 'Kiosk agent is currently offline.'
          );
          return res.status(503).json({
            success: false,
            message: 'Kiosk is currently offline.',
            error_code: 'KIOSK_OFFLINE',
            data: responseData(failed || { ...job, status: 'failed' }),
          });
        }

        deps.schedulePrintJobTimeout(job.job_id, kiosk.id, {
          onTimeout: timedOutJob => deps.broadcastToAdmin('kiosk:print_job_updated', {
            kioskId: kiosk.id,
            job: timedOutJob,
          }),
        });

        const dispatched = deps.sendKioskCommand(kiosk.id, 'PRINT_PHOTO', {
          job_id: job.job_id,
          session_code: sessionIdentifier,
          image_url: request.image_url,
          copies: request.copies,
          paper_size: request.paper_size,
          orientation: request.orientation,
        });

        if (!dispatched) {
          deps.clearPrintJobTimeout(job.job_id);
          const failed = await deps.printJobModel.markFailedIfPending(
            job.job_id, kiosk.id, 'KIOSK_OFFLINE', 'Kiosk disconnected before the print command was dispatched.'
          );
          return res.status(503).json({
            success: false,
            message: 'Kiosk is currently offline.',
            error_code: 'KIOSK_OFFLINE',
            data: responseData(failed || { ...job, status: 'failed' }),
          });
        }

        console.log(`[Print] Queued job ${job.job_id} for kiosk ${kiosk.id}, session ${sessionIdentifier}`);
        return res.status(202).json({
          success: true,
          message: 'Print job queued.',
          data: responseData(job),
        });
      } catch (error) {
        return next(error);
      }
    },

    getPrintJob: async (req, res, next) => {
      try {
        let job = await deps.printJobModel.findByIdForKiosk(req.params.job_id, req.kiosk.id);
        if (!job) {
          return res.status(404).json({ success: false, message: 'Print job not found.', error_code: 'PRINT_JOB_NOT_FOUND' });
        }

        const timeoutMs = Number(process.env.PRINT_JOB_TIMEOUT_MS) || 60 * 1000;
        const ageMs = Date.now() - new Date(job.created_at).getTime();
        if ((job.status === 'queued' || job.status === 'printing') && ageMs > timeoutMs) {
          job = await deps.printJobModel.markFailedIfPending(
            job.job_id, req.kiosk.id, 'PRINT_TIMEOUT', `Kiosk did not finish printing within ${timeoutMs} ms.`
          ) || job;
        }
        return res.status(200).json({
          success: true,
          data: deps.printJobModel.formatPrintJob(job),
        });
      } catch (error) {
        return next(error);
      }
    },
  };
}

module.exports = Object.assign(createPrintJobController(), { createPrintJobController, samePrintRequest });
