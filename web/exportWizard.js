// ============================================================
// exportWizard.js - 虚拟机导出/导入向导
//
// 导出步骤: 摘要 → 额外文件 → 导出
//   Step 1 (摘要): 显示将要导出的内容 (配置/磁盘/EEPROM等)
//   Step 2 (额外文件): 允许用户添加额外文件或文件夹, 默认直接下一步
//   Step 3 (导出): 执行导出并触发下载
//
// 导入: 选择导出文件 → 显示摘要 → 导入
// ============================================================

const ExportWizard = (() => {
  // ---------- 状态 ----------
  let mode = 'export';     // 'export' | 'import'
  let vmName = '';
  let currentStep = 0;
  let extraFiles = [];      // [{path, content(base64), binary, size}]
  let importData = null;    // 解析后的导入数据
  let onDone = null;

  // ---------- 工具 ----------
  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function stepBarHTML(steps) {
    return `
      <div class="wizard-progress">
        ${steps.map((s, i) => `
          <div class="wizard-progress-step ${i === currentStep ? 'active' : (i < currentStep ? 'done' : '')}">
            ${i + 1}. ${s}
          </div>
        `).join('')}
      </div>
    `;
  }

  // ---------- 文件读取 ----------
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result = "data:...;base64,XXXX"
        const result = reader.result;
        const commaIdx = result.indexOf(',');
        const b64 = commaIdx >= 0 ? result.substring(commaIdx + 1) : result;
        resolve(b64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // 读取文件夹中的所有文件 (递归)
  async function readDirectoryEntries(item, prefix = '') {
    const entries = [];
    if (item.isFile) {
      return new Promise((resolve) => {
        item.file(async (file) => {
          const path = prefix ? prefix + '/' + file.name : file.name;
          const b64 = await readFileAsBase64(file);
          entries.push({
            path: path,
            content: b64,
            binary: !file.type.startsWith('text/'),
            size: file.size,
          });
          resolve(entries);
        });
      });
    } else if (item.isDirectory) {
      const dirReader = item.createReader();
      const allEntries = [];
      // readEntries 可能需要多次调用
      const readBatch = () => new Promise((resolve) => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve();
          } else {
            allEntries.push(...batch);
            readBatch().then(resolve);
          }
        }, () => resolve());
      });
      await readBatch();
      const dirPath = prefix ? prefix + '/' + item.name : item.name;
      for (const entry of allEntries) {
        const sub = await readDirectoryEntries(entry, dirPath);
        entries.push(...sub);
      }
    }
    return entries;
  }

  // ============================================================
  // 导出模式
  // ============================================================

  // Step 0: 摘要
  function exportSummaryHTML() {
    const steps = ['摘要', '额外文件', '导出'];
    return `
      ${stepBarHTML(steps)}
      <div class="wizard-step active">
        <div class="section-title">导出摘要</div>
        <p class="hint" style="margin-bottom:12px;">
          以下内容将被包含在导出包中:
        </p>
        <div class="export-summary">
          <div class="form-row"><label>虚拟机名称</label><span>${escapeHTML(vmName)}</span></div>
          <div class="form-row"><label>配置文件</label><span>config.json (硬件配置、APU、内存等)</span></div>
          <div class="form-row"><label>磁盘文件</label><span>所有 .ocd 磁盘镜像 (加密压缩格式)</span></div>
          <div class="form-row"><label>EEPROM</label><span>BIOS/EEPROM 固件 (.oce, 如存在)</span></div>
        </div>
        <div class="section-title" style="margin-top:16px;">导出格式</div>
        <div class="form-row">
          <label>格式</label>
          <span>.ocvm (JSON, 含 base64 编码文件内容)</span>
        </div>
        <p class="hint" style="margin-top:8px;">
          导出包可通过「导入虚拟机」功能在其他 OC Emulator 实例中恢复。
        </p>
      </div>
    `;
  }

  // Step 1: 额外文件
  function exportExtraFilesHTML() {
    const steps = ['摘要', '额外文件', '导出'];
    let fileListHTML = '';
    if (extraFiles.length === 0) {
      fileListHTML = '<p class="hint" style="text-align:center;padding:16px;">未添加额外文件。如不需要, 直接点击「下一步」继续。</p>';
    } else {
      fileListHTML = `
        <table class="export-file-table">
          <thead>
            <tr><th>路径</th><th>大小</th><th>类型</th><th></th></tr>
          </thead>
          <tbody>
            ${extraFiles.map((f, i) => `
              <tr>
                <td title="${escapeHTML(f.path)}">${escapeHTML(f.path)}</td>
                <td>${formatSize(f.size)}</td>
                <td>${f.binary ? '二进制' : '文本'}</td>
                <td><button class="btn btn-small" data-action="remove-file" data-idx="${i}">移除</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }
    return `
      ${stepBarHTML(steps)}
      <div class="wizard-step active">
        <div class="section-title">额外文件 / 文件夹</div>
        <p class="hint" style="margin-bottom:12px;">
          可选: 添加额外的 Lua 库、配置文件、资源文件或整个文件夹到导出包中。
          如果不需要额外文件, 直接点击「下一步」继续。
        </p>
        <div class="export-add-buttons">
          <label class="btn btn-secondary">
            ＋ 添加文件
            <input type="file" id="ew-file-input" multiple style="display:none;">
          </label>
          <label class="btn btn-secondary">
            ＋ 添加文件夹
            <input type="file" id="ew-folder-input" webkitdirectory directory multiple style="display:none;">
          </label>
          <button class="btn btn-secondary" data-action="clear-files">清空</button>
        </div>
        <div id="ew-file-list" style="margin-top:12px;">
          ${fileListHTML}
        </div>
      </div>
    `;
  }

  // Step 2: 导出执行
  function exportExecHTML() {
    const steps = ['摘要', '额外文件', '导出'];
    return `
      ${stepBarHTML(steps)}
      <div class="wizard-step active" id="ew-export-pane">
        <div class="section-title">导出虚拟机</div>
        <div id="ew-export-status">
          <p style="text-align:center;padding:24px;">点击「导出」按钮开始导出虚拟机 <strong>${escapeHTML(vmName)}</strong>。</p>
          <div class="export-summary" style="margin-top:8px;">
            <div class="form-row"><label>额外文件数</label><span>${extraFiles.length} 个文件</span></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderExportBody() {
    if (currentStep === 0) return exportSummaryHTML();
    if (currentStep === 1) return exportExtraFilesHTML();
    if (currentStep === 2) return exportExecHTML();
    return '';
  }

  function renderExportFooter() {
    if (currentStep === 0) {
      return `<button class="btn" data-action="cancel">取消</button>
              <button class="btn btn-primary" data-action="next">下一步 →</button>`;
    } else if (currentStep === 1) {
      return `<button class="btn" data-action="prev">← 上一步</button>
              <button class="btn btn-primary" data-action="next">下一步 →</button>`;
    } else {
      return `<button class="btn" data-action="prev">← 上一步</button>
              <button class="btn btn-primary" data-action="do-export">导出</button>`;
    }
  }

  function rerender() {
    document.getElementById('modal-body').innerHTML = renderExportBody();
    document.getElementById('modal-footer').innerHTML = renderExportFooter();
    bindStepEvents();
  }

  function bindStepEvents() {
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');

    // Step 1: 额外文件 - 文件输入
    const fileInput = body.querySelector('#ew-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
          const b64 = await readFileAsBase64(file);
          extraFiles.push({
            path: file.name,
            content: b64,
            binary: !file.type.startsWith('text/'),
            size: file.size,
          });
        }
        // 重置 input 以允许重复选择同一文件
        e.target.value = '';
        rerender();
      });
    }

    // Step 1: 文件夹输入
    const folderInput = body.querySelector('#ew-folder-input');
    if (folderInput) {
      folderInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
          // webkitRelativePath 包含文件夹名
          const relPath = file.webkitRelativePath || file.name;
          const b64 = await readFileAsBase64(file);
          extraFiles.push({
            path: relPath,
            content: b64,
            binary: !file.type.startsWith('text/'),
            size: file.size,
          });
        }
        e.target.value = '';
        rerender();
      });
    }

    // Step 1: 移除文件 / 清空
    body.querySelectorAll('[data-action="remove-file"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        extraFiles.splice(idx, 1);
        rerender();
      });
    });
    const clearBtn = body.querySelector('[data-action="clear-files"]');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        extraFiles = [];
        rerender();
      });
    }

    // Footer 按钮
    footer.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => onAction(btn.dataset.action));
    });
  }

  async function onAction(action) {
    if (action === 'cancel') {
      Modal.close();
    } else if (action === 'next') {
      currentStep++;
      rerender();
    } else if (action === 'prev') {
      currentStep--;
      rerender();
    } else if (action === 'do-export') {
      await doExport();
    }
  }

  async function doExport() {
    const statusEl = document.getElementById('ew-export-status');
    if (statusEl) {
      statusEl.innerHTML = '<p style="text-align:center;padding:24px;">正在导出... 请稍候。</p>';
    }
    try {
      // 构建请求体
      const extraFilesPayload = extraFiles.map(f => ({
        path: f.path,
        content: f.content,
        binary: f.binary,
      }));
      // 按 folder 分组
      const extraDirs = [];
      const standaloneFiles = [];
      for (const f of extraFiles) {
        const slashIdx = f.path.indexOf('/');
        if (slashIdx > 0) {
          const dirName = f.path.substring(0, slashIdx);
          const relPath = f.path.substring(slashIdx + 1);
          let dir = extraDirs.find(d => d.path === dirName);
          if (!dir) {
            dir = { path: dirName, files: [] };
            extraDirs.push(dir);
          }
          dir.files.push({ path: relPath, content: f.content, binary: f.binary });
        } else {
          standaloneFiles.push({ path: f.path, content: f.content, binary: f.binary });
        }
      }

      const result = await App.api(`vms/${encodeURIComponent(vmName)}/export`, {
        method: 'POST',
        body: {
          extraFiles: standaloneFiles,
          extraDirs: extraDirs,
        },
      });

      if (!result || result.error) {
        throw new Error(result ? result.error : '导出失败');
      }

      // 生成下载文件名
      const fileName = `${vmName}.ocvm`;
      // 将 JSON 转为 Blob 并下载
      const jsonStr = JSON.stringify(result, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (statusEl) {
        const totalFiles = result.files ? result.files.length : 0;
        statusEl.innerHTML = `
          <p style="text-align:center;padding:16px;color:var(--ok);">
            ✓ 导出成功! 已下载 ${escapeHTML(fileName)}
          </p>
          <div class="export-summary" style="margin-top:8px;">
            <div class="form-row"><label>总文件数</label><span>${totalFiles}</span></div>
            <div class="form-row"><label>导出时间</label><span>${escapeHTML(result.manifest.exportedAt)}</span></div>
          </div>
        `;
      }

      // 更新 footer
      document.getElementById('modal-footer').innerHTML =
        '<button class="btn btn-primary" data-action="finish">完成</button>';
      document.getElementById('modal-footer').querySelector('[data-action="finish"]')
        .addEventListener('click', () => {
          Modal.close();
          if (onDone) onDone();
        });
    } catch (e) {
      if (statusEl) {
        statusEl.innerHTML = `<p style="text-align:center;padding:16px;color:var(--err);">✗ 导出失败: ${escapeHTML(e.message)}</p>`;
      }
      // 更新 footer 允许重试
      document.getElementById('modal-footer').innerHTML =
        '<button class="btn" data-action="prev">← 上一步</button>' +
        '<button class="btn btn-primary" data-action="do-export">重试导出</button>';
      document.getElementById('modal-footer').querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => onAction(btn.dataset.action));
      });
    }
  }

  // ---------- 导出: 入口 ----------
  function openExport(name) {
    mode = 'export';
    vmName = name;
    currentStep = 0;
    extraFiles = [];
    onDone = null;
    Modal.open({
      title: `导出虚拟机 — ${name}`,
      size: 'large',
      bodyHTML: renderExportBody(),
      footerHTML: renderExportFooter(),
      onMount: bindStepEvents,
    });
  }

  // ============================================================
  // 导入模式
  // ============================================================

  function importSelectHTML() {
    return `
      <div class="wizard-step active">
        <div class="section-title">选择导出文件</div>
        <p class="hint" style="margin-bottom:12px;">
          选择之前导出的 <code>.ocvm</code> 文件以导入虚拟机。
        </p>
        <div class="form-row">
          <label>导出文件</label>
          <input type="file" id="iw-file-input" accept=".ocvm,.json">
        </div>
        <div id="iw-summary" style="margin-top:12px;"></div>
      </div>
    `;
  }

  function renderImportBody() {
    return importSelectHTML();
  }

  function renderImportFooter() {
    return `<button class="btn" data-action="cancel">取消</button>
            <button class="btn btn-primary" data-action="do-import" id="iw-import-btn" disabled>导入</button>`;
  }

  function bindImportEvents() {
    const body = document.getElementById('modal-body');
    const footer = document.getElementById('modal-footer');
    const fileInput = body.querySelector('#iw-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          importData = JSON.parse(text);
          if (!importData.manifest || importData.manifest.format !== 'oc-vm-export') {
            throw new Error('无效的导出文件格式');
          }
          // 显示摘要
          const summaryEl = body.querySelector('#iw-summary');
          const m = importData.manifest;
          const fileCount = importData.files ? importData.files.length : 0;
          let totalSize = 0;
          if (importData.files) {
            for (const f of importData.files) {
              if (f.content) totalSize += Math.floor(f.content.length * 3 / 4);
            }
          }
          summaryEl.innerHTML = `
            <div class="export-summary">
              <div class="form-row"><label>虚拟机名称</label><span>${escapeHTML(m.vmName)}</span></div>
              <div class="form-row"><label>导出时间</label><span>${escapeHTML(m.exportedAt)}</span></div>
              <div class="form-row"><label>格式版本</label><span>v${m.version}</span></div>
              <div class="form-row"><label>文件数</label><span>${fileCount}</span></div>
              <div class="form-row"><label>总大小</label><span>${formatSize(totalSize)}</span></div>
              <div class="form-row"><label>配置</label><span>
                ${m.config && m.config.apu ? I18N.t('vm.meta.apu') + ' ' + (m.config.apu.tier === 'creative' ? I18N.t('vm.meta.creative') : 'T' + m.config.apu.tier) : ''} ·
                ${m.config && Array.isArray(m.config.memory) ? I18N.t('vm.meta.ram') + ' T' + m.config.memory.join('/') : ''}
              </span></div>
            </div>
          `;
          // 启用导入按钮
          const importBtn = footer.querySelector('#iw-import-btn');
          if (importBtn) importBtn.disabled = false;
        } catch (err) {
          const summaryEl = body.querySelector('#iw-summary');
          summaryEl.innerHTML = `<p style="color:var(--err);">✗ 无法解析文件: ${escapeHTML(err.message)}</p>`;
          importData = null;
          const importBtn = footer.querySelector('#iw-import-btn');
          if (importBtn) importBtn.disabled = true;
        }
      });
    }

    footer.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'cancel') Modal.close();
        else if (action === 'do-import') doImport();
      });
    });
  }

  async function doImport() {
    if (!importData) return;
    const footer = document.getElementById('modal-footer');
    footer.innerHTML = '<button class="btn" disabled>导入中...</button>';
    try {
      const result = await App.api('vms/import', {
        method: 'POST',
        body: importData,
      });
      if (!result || result.error) {
        throw new Error(result ? result.error : '导入失败');
      }
      const summaryEl = document.getElementById('iw-summary');
      if (summaryEl) {
        summaryEl.innerHTML = `<p style="color:var(--ok);text-align:center;padding:16px;">
          ✓ 虚拟机 "${escapeHTML(result.name)}" 导入成功!
        </p>`;
      }
      footer.innerHTML = '<button class="btn btn-primary" data-action="finish">完成</button>';
      footer.querySelector('[data-action="finish"]').addEventListener('click', () => {
        Modal.close();
        App.refreshVMs();
      });
    } catch (e) {
      const summaryEl = document.getElementById('iw-summary');
      if (summaryEl) {
        summaryEl.innerHTML = `<p style="color:var(--err);">✗ 导入失败: ${escapeHTML(e.message)}</p>`;
      }
      footer.innerHTML = '<button class="btn" data-action="cancel">取消</button><button class="btn btn-primary" data-action="do-import">重试</button>';
      footer.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'cancel') Modal.close();
          else if (action === 'do-import') doImport();
        });
      });
    }
  }

  // ---------- 导入: 入口 ----------
  function openImport() {
    mode = 'import';
    importData = null;
    Modal.open({
      title: '导入虚拟机',
      size: 'large',
      bodyHTML: renderImportBody(),
      footerHTML: renderImportFooter(),
      onMount: bindImportEvents,
    });
  }

  return {
    open: openExport,
    openImport: openImport,
  };
})();

window.ExportWizard = ExportWizard;
