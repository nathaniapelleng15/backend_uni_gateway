const pool = require('../config/db');
const { publicBaseUrl } = require('../utils/security');

const serveDownloadPage = async (req, res, next) => {
  try {
    const { session_code } = req.params;

    // Fetch session configuration to check validation
    const [sessions] = await pool.query(
      'SELECT session_code, status, created_at FROM sessions WHERE session_code = ? LIMIT 1',
      [session_code]
    );

    if (sessions.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Session Not Found - Uni-Smiles</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-[#0c1633] text-white h-screen flex flex-col items-center justify-center font-sans p-4">
          <div class="text-center space-y-6">
            <h1 class="text-4xl font-extrabold text-red-500 uppercase tracking-wider">404 Session Not Found</h1>
            <p class="text-white/70 max-w-md">Tautan download sudah kedaluwarsa atau kode sesi <strong>#${session_code}</strong> tidak ditemukan.</p>
            <a href="https://uni-smiles.com" class="inline-block bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-3 rounded-xl transition-all">Kembali ke Beranda</a>
          </div>
        </body>
        </html>
      `);
    }

    // Fetch photos
    const [photos] = await pool.query(
      "SELECT url FROM photos WHERE session_id = ? AND url NOT LIKE '/uploads/print/%' ORDER BY id ASC",
      [session_code]
    );

    const baseUrl = publicBaseUrl(req);

    // Separate individual shots vs framed photo
    const allPhotos = photos.map(p => {
      return p.url.startsWith('http') ? p.url : `${baseUrl}${p.url.startsWith('/') ? '' : '/'}${p.url}`;
    });

    let framePhoto = null;
    let singlePhotos = [];

    if (allPhotos.length > 0) {
      const frameUrl = allPhotos.find(url => url.includes('_frame'));
      if (frameUrl) {
        framePhoto = frameUrl;
        singlePhotos = allPhotos.filter(url => !url.includes('_frame'));
      } else if (allPhotos.length > 1) {
        framePhoto = allPhotos[allPhotos.length - 1];
        singlePhotos = allPhotos.slice(0, -1);
      } else {
        framePhoto = allPhotos[0];
      }
    }

    // Generate HTML for the download page
    res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Download Foto Uni-Smiles Sesi #${session_code}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;900&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Outfit', sans-serif;
          }
          .glass {
            background: rgba(255, 255, 255, 0.03);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.08);
          }
          .glass-button {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          }
          .glass-button:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.2);
            transform: translateY(-2px);
          }
          .glow-bg {
            position: absolute;
            width: 500px;
            height: 500px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(79, 70, 229, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
            filter: blur(60px);
            pointer-events: none;
            z-index: 0;
          }
        </style>
      </head>
      <body class="bg-[#0c1633] text-slate-100 min-h-screen relative overflow-x-hidden flex flex-col justify-between selection:bg-indigo-500 selection:text-white">
        <!-- Glows -->
        <div class="glow-bg top-[-10%] left-[-10%] animate-pulse"></div>
        <div class="glow-bg bottom-[-10%] right-[-10%] animate-pulse" style="animation-duration: 4s;"></div>

        <!-- Main Wrapper -->
        <div class="max-w-6xl w-full mx-auto px-4 py-8 z-10 flex-1">
          <!-- Header -->
          <header class="flex flex-col md:flex-row justify-between items-center mb-12 gap-6 text-center md:text-left">
            <div class="flex items-center gap-4">
              <img src="/assets/LOGO UNI-SMILE.png" alt="Uni-Smiles" class="h-32 w-56 object-contain" onerror="this.style.display='none'">
              <div>
                <h1 class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-indigo-400 bg-clip-text text-transparent uppercase">Uni-Smiles</h1>
                <p class="text-xs font-semibold text-indigo-400 tracking-widest uppercase">Digital Copy Center</p>
              </div>
            </div>
            
            <div class="glass px-6 py-3 rounded-2xl flex items-center gap-3">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
              <p class="text-sm font-bold text-slate-300">Sesi Aktif: <span class="text-indigo-300">#${session_code}</span></p>
            </div>
          </header>

          <main class="space-y-12">
            <!-- Frame Result (Prominent View) -->
            ${framePhoto ? `
            <section class="space-y-4">
              <div class="flex items-center gap-3 border-b border-white/10 pb-2">
                <span class="text-2xl">🖼️</span>
                <h2 class="text-xl font-bold uppercase tracking-wider text-slate-200">Foto Frame (Hasil Akhir)</h2>
              </div>
              
              <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center bg-white/5 rounded-3xl p-6 md:p-8 glass shadow-2xl">
                <div class="lg:col-span-6 flex justify-center">
                  <div class="relative group rounded-2xl overflow-hidden shadow-2xl transition-transform duration-500 hover:scale-[1.01] max-w-sm md:max-w-md w-full">
                    <img src="${framePhoto}" alt="Foto Frame Uni-Smiles" class="w-full h-auto object-contain">
                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                      <p class="text-white text-sm font-bold tracking-wider uppercase">Uni-Smiles Memory</p>
                    </div>
                  </div>
                </div>
                
                <div class="lg:col-span-6 space-y-6 text-center lg:text-left">
                  <div class="space-y-2">
                    <h3 class="text-2xl md:text-3xl font-black text-white">Salinan Foto Cetak Anda</h3>
                    <p class="text-sm text-slate-400">Hasil gabungan jepretan Anda dengan template frame eksklusif Uni-Smiles.</p>
                  </div>

                  <div class="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                    <a href="${framePhoto}" download="unismiles-frame-${session_code}.png" class="flex items-center justify-center gap-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-indigo-600/20 active:scale-95 transition-all text-base">
                      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                      Download Hasil Frame
                    </a>
                  </div>
                </div>
              </div>
            </section>
            ` : ''}

            <!-- Individual Shots -->
            ${singlePhotos.length > 0 ? `
            <section class="space-y-6">
              <div class="flex items-center gap-3 border-b border-white/10 pb-2">
                <span class="text-2xl">📸</span>
                <h2 class="text-xl font-bold uppercase tracking-wider text-slate-200">Foto Satuan (Mentah)</h2>
              </div>
              
              <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                ${singlePhotos.map((url, index) => `
                <div class="glass rounded-3xl p-4 flex flex-col justify-between group hover:border-indigo-500/30 transition-all duration-300">
                  <div class="rounded-2xl overflow-hidden shadow-lg bg-black/40 aspect-[4/3] flex items-center justify-center relative">
                    <img src="${url}" alt="Foto Satuan ${index + 1}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                  </div>
                  <div class="mt-4 space-y-3">
                    <p class="text-xs font-bold text-slate-400">Jepretan #${index + 1}</p>
                    <a href="${url}" download="unismiles-satuan-${index + 1}-${session_code}.png" class="glass-button w-full py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 text-indigo-300 hover:text-white">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                      Download Foto
                    </a>
                  </div>
                </div>
                `).join('')}
              </div>
            </section>
            ` : ''}
          </main>
        </div>

        <!-- Footer -->
        <footer class="border-t border-white/5 py-8 text-center text-xs text-slate-500 z-10 bg-black/20">
          <p>© 2026 Uni-Smiles Photobooth. Semua hak cipta dilindungi.</p>
        </footer>
      </body>
      </html>
    `);
  } catch (err) {
    next(err);
  }
};

module.exports = { serveDownloadPage };
