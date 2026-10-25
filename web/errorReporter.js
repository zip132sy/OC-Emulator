// ============================================================
// errorReporter.js - 前端全局错误捕获
// 捕获脚本运行时错误与未处理的 Promise 拒绝, 弹出错误面板:
//   - 显示错误摘要与调用栈
//   - 一键复制完整错误信息
//   - 跳转 GitHub / Gitee 提交 Issue
// ============================================================
(() => {
  if (window.ErrorReporter) return;

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
`;
    document.head.appendChild(style);
  }

  // ---------- 面板 ----------
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
      body.appendChild(sum);
      body.appendChild(pre);

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

      foot.appendChild(copyBtn);
      foot.appendChild(copiedHint);
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

  window.ErrorReporter = { report, show, copyText, REPO, VERSION };
})();
