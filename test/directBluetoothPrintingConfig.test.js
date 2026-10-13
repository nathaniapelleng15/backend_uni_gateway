const test = require('node:test');
const assert = require('node:assert/strict');
const {validatePrintingConfig, toSocketPrintingConfig} = require('../utils/printingConfigValidation');

test('direct Bluetooth saves enabled printing with system adapter disabled and no OS printer', () => {
  const result = validatePrintingConfig({printing_enabled:true,adapter:'disabled',printer_name:null,paper_size:'4R'}, {}, {
    supported_adapters:['cups'], available_printers:[{name:'Office Printer'}],
  });
  assert.equal(result.printing_enabled,true);
  assert.equal(result.adapter,'disabled','must not silently switch transport to agent BLE/CUPS');
  assert.equal(result.printer_name,null);
  assert.equal(result.paper_size,'4R');
  const socket = toSocketPrintingConfig(result);
  assert.equal(socket.enabled,true);assert.equal(socket.adapter,'disabled');
});

test('existing Bluetooth AUTO row can save calibration without changing agent adapter', () => {
  const result = validatePrintingConfig({photo_brightness:110}, {printing_enabled:1,adapter:'disabled',printer_name:'AUTO',paper_size:'4R',print_margin_top_px:70,print_margin_right_px:83,print_margin_left_px:0,print_margin_bottom_px:154});
  assert.equal(result.printing_enabled,true);assert.equal(result.adapter,'disabled');assert.equal(result.photo_brightness,110);
  assert.deepEqual([result.print_margin_top_px,result.print_margin_right_px,result.print_margin_left_px,result.print_margin_bottom_px],[70,83,0,154]);
});

test('OS adapter still requires actual reported support and printer selection', () => {
  assert.throws(()=>validatePrintingConfig({printing_enabled:true,adapter:'cups',printer_name:null}), /printer_name is required/);
  assert.throws(()=>validatePrintingConfig({printing_enabled:true,adapter:'windows',printer_name:'Office Printer'}, {}, {supported_adapters:['cups']}), /not supported/);
  assert.throws(()=>validatePrintingConfig({printing_enabled:true,adapter:'cups',printer_name:'Missing Printer'}, {}, {supported_adapters:['cups'],available_printers:[{name:'Office Printer'}]}), /not reported/);
});
