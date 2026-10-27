// ============================================================
// errorReporter.js - 前端全局错误捕获
// 捕获脚本运行时错误与未处理的 Promise 拒绝, 弹出错误面板:
//   - 显示错误摘要与调用栈
//   - 匹配常见错误, 给出可能原因与解决步骤
//   - 一键复制完整错误信息
//   - 跳转 GitHub / Gitee 提交 Issue
// ============================================================
(() => {
  if (window.ErrorReporter) return;

  // ---------- 常见错误说明与解决方法 ----------
  // 每条规则匹配错误摘要或调用栈, 命中后显示原因和处理步骤
  const ERROR_GUIDE = [
    {
      test: /luaExe|lua not found|未找到 ?lua|lua 路径|Lua check failed|Lua: failed/i,
      title: { zh: '找不到 Lua 解释器', en: 'Lua interpreter not found' },
      cause: { zh: '启动时没有找到 lua 可执行文件, 或设置里的路径已经失效。', en: 'The lua executable was not found, or the configured path is stale.' },
      fix: {
        zh: ['在「⚙ Settings」里重新选择 lua 可执行文件 (Windows 用 lua5.1.exe)', '确认该文件存在, 并且当前用户有执行权限', '保存后重启服务'],
        en: ['Pick the lua executable again in Settings (lua5.1.exe on Windows)', 'Make sure the file exists and is executable', 'Restart the server after saving'],
      },
    },
    {
      test: /EADDRINUSE|address already in use|端口.{0,6}占用/i,
      title: { zh: '端口被占用', en: 'Port already in use' },
      cause: { zh: '默认端口 8080 已被其它程序占用。', en: 'The default port 8080 is already used by another program.' },
      fix: {
        zh: ['关闭占用该端口的程序后重试', '或直接重启服务, 它会自动尝试 8080 之后的端口', '用启动窗口打印的地址打开控制面板'],
        en: ['Close the program using the port and retry', 'Or restart the server; it retries ports above 8080', 'Open the address printed in the server window'],
      },
    },
    {
      test: /Failed to fetch|NetworkError|网络连接失败|WebSocket.{0,20}(closed|error)|连接已断开/i,
      title: { zh: '连不上本地服务', en: 'Cannot reach the local server' },
      cause: { zh: '页面与 Node 服务之间的连接中断 (服务未启动、已退出或端口变化)。', en: 'The connection to the Node server was lost (not running, exited, or port changed).' },
      fix: {
        zh: ['确认启动窗口仍在运行且没有报错', '重新执行 run.bat / run.sh', '回到页面按 Ctrl+F5 硬刷新'],
        en: ['Make sure the server window is still running without errors', 'Start run.bat / run.sh again', 'Reload the page with Ctrl+F5'],
      },
    },
    {
      test: /cannot load disk|cannot load floppy|无法加载磁盘|disk not found/i,
      title: { zh: '磁盘/软盘无法读取', en: 'Disk or floppy cannot be read' },
      cause: { zh: '镜像文件损坏、路径不对, 或被其它程序占用。', en: 'The image file is damaged, misplaced, or locked by another program.' },
      fix: {
        zh: ['检查虚拟机配置里对应盘位的文件是否存在', '关闭可能占用该文件的其它实例或编辑器', '必要时用磁盘模板重新创建'],
        en: ['Check that the file for that slot exists', 'Close other instances or editors using the file', 'Recreate it from a disk template if needed'],
      },
    },
    {
      test: /disk locked|floppy locked|磁盘已锁定|软盘已锁定/i,
      title: { zh: '磁盘处于锁定状态', en: 'Disk is locked' },
      cause: { zh: '镜像被标记为只读, 写入会被拒绝。', en: 'The image is marked read-only, so writes are rejected.' },
      fix: {
        zh: ['打开磁盘编辑器点「解锁」后再操作', '软盘模板默认只读, 复制到虚拟机后再修改'],
        en: ['Unlock the disk in the disk editor', 'Floppy templates are read-only; copy them into a VM before editing'],
      },
    },
    {
      test: /no such component|组件不存在|no such method|attempt to call a nil value \(field/i,
      title: { zh: '组件或方法不存在', en: 'Component or method not found' },
      cause: { zh: '程序访问的组件没有安装、没有接入当前计算机, 或方法名不匹配。', en: 'The component is missing, not connected to this computer, or the method name differs.' },
      fix: {
        zh: ['确认扩展卡 / 设备已装到这台虚拟机', '核电站与自定义机器需要先在设备页点「连接到虚拟机」', '用 component.list() 与 component.doc() 核对地址和方法'],
        en: ['Make sure the card/device is installed on this VM', 'For reactors and machines, click "Connect to VM" in the device page', 'Check addresses and methods with component.list() and component.doc()'],
      },
    },
    {
      test: /attempt to index a nil value|attempt to compare nil|attempt to call a nil value/i,
      title: { zh: 'Lua 访问了空值', en: 'Lua accessed a nil value' },
      cause: { zh: '脚本里某个变量或组件还没有初始化。', en: 'A variable or component in the script was not initialized.' },
      fix: {
        zh: ['按提示的文件与行号检查该变量', '用 component.isAvailable() 判断组件后再调用', '确认程序要求的组件与模拟器一致'],
        en: ['Check the variable at the reported file and line', 'Guard calls with component.isAvailable()', 'Make sure the required components match the emulator'],
      },
    },
    {
      test: /syntax error|unexpected symbol|expected .{0,10}near|near '[^']*'/i,
      title: { zh: 'Lua 脚本语法错误', en: 'Lua syntax error' },
      cause: { zh: '脚本无法被加载, 通常是括号、end 或逗号不匹配。', en: 'The script cannot be loaded, usually a mismatched bracket, end, or comma.' },
      fix: {
        zh: ['按提示的文件与行号检查上下文', '用 luac -p 或 lua_check 做语法校验', '保存后重新运行程序'],
        en: ['Inspect the reported file and line', 'Validate with luac -p or lua_check', 'Save and run the program again'],
      },
    },
    {
      test: /Cannot find module|MODULE_NOT_FOUND/i,
      title: { zh: 'Node 依赖缺失', en: 'Node dependency missing' },
      cause: { zh: 'node_modules 不存在或被删除。', en: 'node_modules is missing or was deleted.' },
      fix: {
        zh: ['在项目目录执行 npm install', '确认 node_modules 已生成', '重启服务'],
        en: ['Run npm install in the project folder', 'Confirm node_modules is created', 'Restart the server'],
      },
    },
    {
      test: /EACCES|EPERM|permission denied|拒绝访问/i,
      title: { zh: '文件权限不足', en: 'Permission denied' },
      cause: { zh: '当前用户对目标文件或目录没有读写权限。', en: 'The current user cannot read or write the target file or folder.' },
      fix: {
        zh: ['把项目放到有写权限的目录', '必要时以管理员身份运行', '关闭占用该文件的程序后重试'],
        en: ['Move the project to a writable folder', 'Run as administrator if necessary', 'Close programs that hold the file and retry'],
      },
    },
    {
      test: /ENOSPC|no space left|磁盘空间不足/i,
      title: { zh: '磁盘空间不足', en: 'Not enough disk space' },
      cause: { zh: '镜像或缓存所在分区已经写满。', en: 'The partition holding images or cache is full.' },
      fix: {
        zh: ['清理不需要的虚拟机与磁盘镜像', '确认镜像所在分区有足够剩余空间', '清理 cache 目录后重试'],
        en: ['Remove unused VMs and disk images', 'Check free space on the image partition', 'Clear the cache folder and retry'],
      },
    },
    {
      test: /HTTP 404|404 Not Found|接口不存在/i,
      title: { zh: '接口不存在 (404)', en: 'Endpoint not found (404)' },
      cause: { zh: '页面请求的接口在当前服务版本里没有 (服务未重启或前后端版本不一致)。', en: 'The requested endpoint is missing (server not restarted or version mismatch).' },
      fix: {
        zh: ['重启 Node 服务', '按 Ctrl+F5 硬刷新页面', '确认前端与服务端来自同一版本'],
        en: ['Restart the Node server', 'Reload the page with Ctrl+F5', 'Make sure frontend and server are the same version'],
      },
    },
    {
      test: /ETIMEDOUT|timed? ?out|超时/i,
      title: { zh: '请求超时', en: 'Request timed out' },
      cause: { zh: '等待响应时间过长, 或本地端口被拦截。', en: 'The response took too long, or the local port is blocked.' },
      fix: {
        zh: ['查看服务窗口是否有报错', '确认防火墙没有拦截本地端口', '稍后重试'],
        en: ['Check the server window for errors', 'Make sure the firewall allows the local port', 'Retry later'],
      },
    },
    {
      test: /out of memory|not enough memory|内存不足|heap out of memory/i,
      title: { zh: '内存不足', en: 'Out of memory' },
      cause: { zh: '运行中的虚拟机或页面占用内存过高。', en: 'Running VMs or the page use too much memory.' },
      fix: {
        zh: ['关闭暂时不用的虚拟机标签页', '降低虚拟机的内存配置', '重启服务后重试'],
        en: ['Close VM tabs you are not using', 'Lower the VM memory configuration', 'Restart the server and retry'],
      },
    },
    {
      test: /ECONNRESET|Connection was reset|连接被重置/i,
      title: { zh: '连接被重置', en: 'Connection reset' },
      cause: { zh: '对端主动断开连接, 常见于访问外部服务 (如 GitHub)。', en: 'The peer closed the connection, often when reaching external services such as GitHub.' },
      fix: {
        zh: ['稍后重试', '换用其它网络或代理', 'Gitee 可用时可以继续使用'],
        en: ['Retry later', 'Try another network or proxy', 'Use Gitee when it is reachable'],
      },
    },
    {
      test: /Invalid VM name|Invalid name/i,
      title: { zh: '名称不合法', en: 'Invalid name' },
      cause: { zh: '名称里包含不允许的字符。', en: 'The name contains characters that are not allowed.' },
      fix: {
        zh: ['只使用字母、数字、下划线和短横线', '长度保持在 1~32 个字符'],
        en: ['Use only letters, digits, underscores and dashes', 'Keep the length between 1 and 32 characters'],
      },
    },
    {
      test: /Cannot read propert|undefined is not an object/i,
      title: { zh: '页面数据不完整', en: 'Page data is incomplete' },
      cause: { zh: '页面拿到的数据缺少字段, 或接口还没有返回。', en: 'The page received incomplete data, or the request has not finished.' },
      fix: {
        zh: ['刷新页面重试', '确认服务窗口没有报错', '记录出现前的操作步骤, 便于定位'],
        en: ['Reload the page and retry', 'Check the server window for errors', 'Note the steps that led to it'],
      },
    },
  ];

  const pick = (entry) => (isEn() ? entry.en : entry.zh);

  function matchGuide(text) {
    const out = [];
    for (const rule of ERROR_GUIDE) {
      if (rule.test.test(text)) out.push(rule);
      if (out.length >= 3) break;
    }
    return out;
  }

  // ---------- 反馈入口 ----------
  const REPO = {
    github: 'https://github.com/zip132sy/OC-Emulator',
    gitee: 'https://gitee.com/zip132sy/OC-Emulator',
  };
  const VERSION = '2.0.0';

  // ---------- 文案 ----------
  function isEn() {
    try {
      if (window.I18N && I18N.getLang) return I18N.getLang() === 'en';
    } catch (_) {}
    return (navigator.language || '').toLowerCase().startsWith('en');
  }
  const tr = (zh, en) => (isEn() ? en : zh);

  // ---------- 去重 ----------
  const seen = new Set();      // 相同错误只弹一次, 避免死循环刷屏
  let panel = null;            // 当前面板
  let currentDetail = '';      // 当前错误的完整文本

  // ---------- 详情文本 ----------
  function buildDetail(summary, stack, source) {
    const lines = [
      tr('【OC Emulator 错误报告】', '[OC Emulator Error Report]'),
      tr('时间: ', 'Time: ') + new Date().toLocaleString(),
      tr('版本: ', 'Version: ') + VERSION,
      tr('页面: ', 'Page: ') + location.href,
      tr('浏览器: ', 'Browser: ') + navigator.userAgent,
      tr('错误: ', 'Error: ') + summary,
    ];
    if (source) lines.push(tr('来源: ', 'Source: ') + source);
    if (stack) lines.push(tr('调用栈:\n', 'Stack trace:\n') + stack);
    return lines.join('\n');
  }

  // ---------- 剪贴板 ----------
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ---------- 反馈链接 (预填标题/内容) ----------
  function issueUrl(kind, summary, detail) {
    const title = '[Bug] ' + String(summary).slice(0, 120);
    let body = detail;
    if (body.length > 1500) body = body.slice(0, 1500) + '\n...(内容过长已截断, 请粘贴复制到的完整信息)';
    const qs = (k, v) => encodeURIComponent(k) + '=' + encodeURIComponent(v);
    if (kind === 'gitee') {
      return REPO.gitee + '/issues/new?' + qs('issue[title]', title) + '&' + qs('issue[body]', body);
    }
    return REPO.github + '/issues/new?' + qs('title', title) + '&' + qs('body', body);
  }

  // ---------- 样式 (自包含, 不依赖 styles.css) ----------
  function injectStyle() {
    if (document.getElementById('err-reporter-style')) return;
    const style = document.createElement('style');
    style.id = 'err-reporter-style';
    style.textContent = `
#err-reporter {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 460px; max-width: calc(100vw - 32px);
  background: #1e1e1e; color: #f0f0f0;
  border: 1px solid #d9534f; border-radius: 6px;
  box-shadow: 0 8px 28px rgba(0,0,0,.55);
  font: 12px/1.5 Consolas, "Courier New", monospace;
  overflow: hidden;
}
#err-reporter .er-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; background: #d9534f; color: #fff; font-weight: bold;
}
#err-reporter .er-head .er-title { display: flex; align-items: center; gap: 6px; }
#err-reporter .er-close {
  background: transparent; border: none; color: #fff; cursor: pointer;
  font-size: 16px; line-height: 1; padding: 0 2px;
}
#err-reporter .er-body { padding: 10px; }
#err-reporter .er-summary { color: #ffb0ac; margin-bottom: 8px; word-break: break-word; }
#err-reporter pre.er-stack {
  margin: 0; padding: 8px; max-height: 200px; overflow: auto;
  background: #121212; border: 1px solid #333; border-radius: 4px;
  white-space: pre-wrap; word-break: break-word; color: #cfcfcf;
}
#err-reporter .er-foot {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 8px 10px; border-top: 1px solid #333; background: #262626;
}
#err-reporter .er-btn {
  padding: 5px 10px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #eee; cursor: pointer; font: inherit; text-decoration: none;
}
#err-reporter .er-btn:hover { background: #3d3d3d; }
#err-reporter .er-btn.er-primary { background: #337ab7; border-color: #337ab7; }
#err-reporter .er-btn.er-primary:hover { background: #286090; }
#err-reporter .er-hint { color: #9a9a9a; font-size: 11px; }
#err-reporter .er-copied { color: #6dd36d; font-size: 11px; }
#err-reporter .er-guide {
  margin-bottom: 8px; padding: 8px;
  background: #1b2a1b; border: 1px solid #3c5a3c; border-radius: 4px;
}
#err-reporter .er-guide-head { color: #9ed69e; font-weight: bold; margin-bottom: 6px; }
#err-reporter .er-guide-item + .er-guide-item { margin-top: 8px; }
#err-reporter .er-guide-title { color: #ffd479; margin-bottom: 2px; }
#err-reporter .er-guide-cause { color: #d0d0d0; }
#err-reporter .er-guide-fix { margin: 4px 0 0 18px; padding: 0; color: #bdbdbd; }
#err-reporter .er-guide-fix li { margin: 2px 0; }
#err-reporter .er-all-guide {
  display: none; max-height: 220px; overflow: auto;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid #333;
}
`;
    document.head.appendChild(style);
  }

  // ---------- 面板 ----------

  function guideItem(rule) {
    const item = document.createElement('div');
    item.className = 'er-guide-item';
    const title = document.createElement('div');
    title.className = 'er-guide-title';
    title.textContent = pick(rule.title);
    const cause = document.createElement('div');
    cause.className = 'er-guide-cause';
    cause.textContent = pick(rule.cause);
    const list = document.createElement('ol');
    list.className = 'er-guide-fix';
    for (const step of pick(rule.fix)) {
      const li = document.createElement('li');
      li.textContent = step;
      list.appendChild(li);
    }
    item.appendChild(title);
    item.appendChild(cause);
    item.appendChild(list);
    return item;
  }

  function guideBlock(rules) {
    const wrap = document.createElement('div');
    wrap.className = 'er-guide';
    const head = document.createElement('div');
    head.className = 'er-guide-head';
    head.textContent = tr('可能原因与解决方法', 'Likely cause and fix');
    wrap.appendChild(head);
    for (const rule of rules) wrap.appendChild(guideItem(rule));
    return wrap;
  }

  function show(summary, stack, source) {
    const detail = buildDetail(summary, stack, source);
    currentDetail = detail;

    try {
      injectStyle();
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'err-reporter';
        document.body.appendChild(panel);
      }
      panel.innerHTML = '';
      panel.style.display = '';

      const head = document.createElement('div');
      head.className = 'er-head';
      const title = document.createElement('span');
      title.className = 'er-title';
      title.textContent = tr('⚠ 运行出错', '⚠ Runtime Error');
      const close = document.createElement('button');
      close.className = 'er-close';
      close.type = 'button';
      close.textContent = '×';
      close.title = tr('关闭', 'Close');
      close.addEventListener('click', () => { panel.style.display = 'none'; });
      head.appendChild(title);
      head.appendChild(close);

      const body = document.createElement('div');
      body.className = 'er-body';
      const sum = document.createElement('div');
      sum.className = 'er-summary';
      sum.textContent = String(summary);
      const pre = document.createElement('pre');
      pre.className = 'er-stack';
      pre.textContent = source ? (source + '\n' + (stack || '')) : (stack || tr('(无调用栈)', '(no stack trace)'));
      const matched = matchGuide(String(summary) + '\n' + (stack || '') + '\n' + (source || ''));
      body.appendChild(sum);
      if (matched.length > 0) body.appendChild(guideBlock(matched));
      body.appendChild(pre);

      // 全部常见错误, 点按钮展开
      const allGuide = document.createElement('div');
      allGuide.className = 'er-all-guide';
      for (const rule of ERROR_GUIDE) allGuide.appendChild(guideItem(rule));
      body.appendChild(allGuide);

      const foot = document.createElement('div');
      foot.className = 'er-foot';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'er-btn er-primary';
      copyBtn.type = 'button';
      copyBtn.textContent = tr('📋 复制错误信息', '📋 Copy error info');
      const copiedHint = document.createElement('span');
      copiedHint.className = 'er-copied';
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(currentDetail);
        copiedHint.textContent = ok
          ? tr('已复制', 'Copied')
          : tr('复制失败, 请手动全选', 'Copy failed, select manually');
        setTimeout(() => { copiedHint.textContent = ''; }, 2500);
      });

      const gh = document.createElement('a');
      gh.className = 'er-btn';
      gh.href = issueUrl('github', summary, detail);
      gh.target = '_blank';
      gh.rel = 'noopener';
      gh.textContent = tr('GitHub 反馈', 'GitHub Feedback');

      const gitee = document.createElement('a');
      gitee.className = 'er-btn';
      gitee.href = issueUrl('gitee', summary, detail);
      gitee.target = '_blank';
      gitee.rel = 'noopener';
      gitee.textContent = tr('Gitee 反馈', 'Gitee Feedback');

      const hint = document.createElement('span');
      hint.className = 'er-hint';
      hint.textContent = tr('复制后粘贴到 Issue 中', 'Paste into the issue');

      const guideBtn = document.createElement('button');
      guideBtn.className = 'er-btn';
      guideBtn.type = 'button';
      guideBtn.textContent = tr('📖 常见错误', '📖 Common errors');
      guideBtn.addEventListener('click', () => {
        allGuide.style.display = allGuide.style.display === 'block' ? 'none' : 'block';
      });

      foot.appendChild(copyBtn);
      foot.appendChild(copiedHint);
      foot.appendChild(guideBtn);
      foot.appendChild(gh);
      foot.appendChild(gitee);
      foot.appendChild(hint);

      panel.appendChild(head);
      panel.appendChild(body);
      panel.appendChild(foot);
    } catch (_) {
      // 报告器自身出错时不能再抛, 回落为控制台输出
    }
  }

  // ---------- 对外接口 ----------
  function report(err) {
    let summary = tr('未知错误', 'Unknown error');
    let stack = '';
    let source = '';
    if (err && err.__ocReport) {
      summary = err.summary; stack = err.stack; source = err.source;
    } else if (err instanceof Error) {
      summary = err.message || String(err);
      stack = err.stack || '';
    } else {
      summary = String(err);
    }
    const key = summary + '|' + stack.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    try { console.error('[ErrorReporter]', summary, stack); } catch (_) {}
    show(summary, stack, source);
  }

  window.addEventListener('error', (e) => {
    // 资源加载失败 (img/script) 也会触发 error 事件, 且无 error 对象
    if (e && e.message) {
      const src = e.filename ? (e.filename + ':' + e.lineno + ':' + e.colno) : '';
      report({ __ocReport: true, summary: e.message, stack: (e.error && e.error.stack) || '', source: src });
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    if (r instanceof Error) report(r);
    else report({ __ocReport: true, summary: 'Unhandled rejection: ' + String(r), stack: '', source: '' });
  });

  window.ErrorReporter = { report, show, copyText, REPO, VERSION, guide: ERROR_GUIDE, matchGuide };
})();
