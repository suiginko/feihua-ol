'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  const custom = 'C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules/jsdom';
  if (fs.existsSync(custom)) {
    ({ JSDOM } = require(custom));
  }
}

if (!JSDOM) {
  console.log('跳过 test_stepper_input（未找到 jsdom）');
  process.exit(0);
}

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

function setupEnv() {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8799/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  window.EventSource = class { close() {} };

  // 加载 app.js
  const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  window.eval(appJs);
  return { dom, window, document: window.document };
}

let pass = 0, fail = 0;
function check(msg, ok, detail) {
  if (ok) {
    pass++;
    console.log('PASS ' + msg);
  } else {
    fail++;
    console.log('FAIL ' + msg + (detail ? ' : ' + detail : ''));
  }
}

function run() {
  const { window, document } = setupEnv();

  // 1. 结构检查：大厅 5 个数字输入框
  const lobbyIds = ['size', 'rounds', 'turnSeconds', 'maxPoemLen', 'extra'];
  for (const id of lobbyIds) {
    const input = document.getElementById(id);
    check(`大厅 #${id} 存在`, !!input);
    const downBtn = document.querySelector(`.nstep-btn[data-step-for="${id}"][data-dir="-1"]`);
    const upBtn = document.querySelector(`.nstep-btn[data-step-for="${id}"][data-dir="1"]`);
    check(`大厅 #${id} 拥有下调按钮(−)`, !!downBtn);
    check(`大厅 #${id} 拥有上调按钮(+)`, !!upBtn);
  }

  // 2. 结构检查：房间开局设置 5 个数字输入框
  const cfgIds = ['cfgSize', 'cfgExtra', 'cfgRounds', 'cfgSeconds', 'cfgMaxLen'];
  for (const id of cfgIds) {
    const input = document.getElementById(id);
    check(`开局设置 #${id} 存在`, !!input);
    const downBtn = document.querySelector(`.nstep-btn[data-step-for="${id}"][data-dir="-1"]`);
    const upBtn = document.querySelector(`.nstep-btn[data-step-for="${id}"][data-dir="1"]`);
    check(`开局设置 #${id} 拥有下调按钮(−)`, !!downBtn);
    check(`开局设置 #${id} 拥有上调按钮(+)`, !!upBtn);
  }

  // 3. 步进点击功能测试（以大厅 size 为例）
  const sizeInput = document.getElementById('size');
  const sizeDown = document.querySelector('.nstep-btn[data-step-for="size"][data-dir="-1"]');
  const sizeUp = document.querySelector('.nstep-btn[data-step-for="size"][data-dir="1"]');

  check('size 初始值为 10', Number(sizeInput.value) === 10, sizeInput.value);
  // 点击上调
  sizeUp.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0 }));
  sizeUp.dispatchEvent(new window.MouseEvent('pointerup', { button: 0 }));
  check('点击上调后 size 变为 11', Number(sizeInput.value) === 11, sizeInput.value);

  // 点击下调
  sizeDown.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0 }));
  sizeDown.dispatchEvent(new window.MouseEvent('pointerup', { button: 0 }));
  check('点击下调后 size 恢复为 10', Number(sizeInput.value) === 10, sizeInput.value);

  // 4. 步进 step 间隔测试（turnSeconds step=5）
  const secInput = document.getElementById('turnSeconds');
  const secUp = document.querySelector('.nstep-btn[data-step-for="turnSeconds"][data-dir="1"]');
  secInput.value = '120';
  secUp.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0 }));
  secUp.dispatchEvent(new window.MouseEvent('pointerup', { button: 0 }));
  check('每步时间按 step=5 递增为 125', Number(secInput.value) === 125, secInput.value);

  // 5. 关键验证：输入过程中上限下限控制器不触发（Bug 2 修复检验）
  // 模拟用户在 sizeInput 中退格删空
  sizeInput.value = '';
  sizeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('用户退格删空 size 时，input 事件中 value 保持为空（不被强改）', sizeInput.value === '', '实际: ' + sizeInput.value);

  // 模拟用户键入 '1'（准备输 15）
  sizeInput.value = '1';
  sizeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('用户键入 1 时，input 事件中 value 保持为 1（不被拉升到 5 或 10）', sizeInput.value === '1', '实际: ' + sizeInput.value);

  // 模拟用户追加 '5'
  sizeInput.value = '15';
  sizeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('用户输入 15 时，input 事件中 value 保持为 15', sizeInput.value === '15', '实际: ' + sizeInput.value);

  // 失焦时才夹逼校验
  sizeInput.dispatchEvent(new window.Event('blur', { bubbles: true }));
  check('失焦后 value 仍稳定为 15', Number(sizeInput.value) === 15, sizeInput.value);

  // 模拟输入超出上限 99，失焦后 clamp 到 20
  sizeInput.value = '99';
  sizeInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('输入 99 过程中保持为 99', sizeInput.value === '99', sizeInput.value);
  sizeInput.dispatchEvent(new window.Event('blur', { bubbles: true }));
  check('失焦后 99 被安全夹到最大路数 20', Number(sizeInput.value) === 20, sizeInput.value);

  // 6. 低频字输入过程不被截断检验
  const extraInput = document.getElementById('extra');
  extraInput.value = '';
  extraInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('用户清空 extra 时保持为空', extraInput.value === '', extraInput.value);

  extraInput.value = '5';
  extraInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('输入 5 过程中保持为 5', extraInput.value === '5', extraInput.value);

  // 7. 房间开局设置 cfgExtra 在输入过程中不被截断检验
  const cfgSize = document.getElementById('cfgSize');
  const cfgExtra = document.getElementById('cfgExtra');
  cfgSize.value = '20'; // 400 格，minExtra = 100
  cfgSize.dispatchEvent(new window.Event('change', { bubbles: true }));

  cfgExtra.value = '1';
  cfgExtra.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('cfgExtra 输入 1 时，虽然小于 100 但输入过程中绝不强改', cfgExtra.value === '1', '实际: ' + cfgExtra.value);

  cfgExtra.value = '150';
  cfgExtra.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('cfgExtra 输完 150 保持为 150', cfgExtra.value === '150', cfgExtra.value);

  cfgExtra.dispatchEvent(new window.Event('blur', { bubbles: true }));
  check('失焦后 150 保持为 150', Number(cfgExtra.value) === 150, cfgExtra.value);

  // 8. 模式切换：单人模式禁用步进器
  const soloRadio = document.querySelector('input[name="playerCount"][value="1"]');
  if (soloRadio) {
    soloRadio.checked = true;
    soloRadio.dispatchEvent(new window.Event('change', { bubbles: true }));

    const secDown = document.querySelector('.nstep-btn[data-step-for="turnSeconds"][data-dir="-1"]');
    const secUp = document.querySelector('.nstep-btn[data-step-for="turnSeconds"][data-dir="1"]');
    const maxLenInput = document.getElementById('maxPoemLen');
    check('单人模式下单次提交时间输入框已 disabled', secInput.disabled === true);
    check('单人模式下单次提交时间值为 ∞', secInput.value === '∞');
    check('单人模式下单次提交时间步进按钮被禁用', secDown.disabled === true && secUp.disabled === true);
    check('单人模式下字数上限输入框已 disabled', maxLenInput.disabled === true);
    check('单人模式下字数上限值也为 ∞（与每手时间一致）', maxLenInput.value === '∞');

    // 切回双人模式
    const duoRadio = document.querySelector('input[name="playerCount"][value="2"]');
    duoRadio.checked = true;
    duoRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('切回双人模式后步进按钮恢复可用', secDown.disabled === false && secUp.disabled === false);
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

run();
