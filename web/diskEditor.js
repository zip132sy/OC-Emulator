// ============================================================
// diskEditor.js - 磁盘编辑器 (VMware 风格)
//
// 调用: App.openTab({ type:'disk-editor', diskPath, vm, title })
// diskPath 是相对 projectDir 的路径, 如 "vms/MyVM/disk1.ocd"
//
// REST API:
//   GET    /api/disks/<path>/info        头信息(不读 body)
//   POST   /api/disks/<path>/unlock     解锁磁盘
//   POST   /api/disks/<path>/lock       锁定磁盘
//   GET    /api/disks/<path>/tree        文件树(仅解锁后)
//   GET    /api/disks/<path>/read?path=  读取内部文件
//   GET    /api/disks/<path>/download?path= 下载内部文件 (带 Content-Length)
//   PUT    /api/disks/<path>/write?path= 写入内部文件
//   POST   /api/disks/<path>/mkdir       新建文件夹
//   DELETE /api/disks/<path>/remove?path= 删除内部文件
//   POST   /api/disks/<path>/format     格式化磁盘
// ============================================================

const DiskEditor = (() => {
  // diskPath -> { tree, selectedPath, locked, info }
  const sessions = new Map();

  function getSession(diskPath) {
    if (!sessions.has(diskPath)) {
      sessions.set(diskPath, {
        diskPath,
        info: null,
        tree: null,
        selectedPath: null,
        selectedFile: null,
        expandedDirs: new Set(), // 展开的文件夹路径
        searchQuery: '',         // 搜索关键词
        currentDir: '/',         // 当前浏览的目录 (上传 / 新建时的默认位置)
      });
    }
    return sessions.get(diskPath);
  }

  function render(pane, diskPath, vm) {
    const session = getSession(diskPath);
    pane.innerHTML = `
      <div class="disk-editor">
        <div class="disk-tree">
          <div class="disk-tree-header">
            <div class="disk-tree-actions">
              <button class="btn btn-icon" title="${I18N.t('disk.new-folder')}" data-action="new-folder" id="disk-newfolder-${cssEsc(diskPath)}">📁</button>
              <button class="btn btn-icon" title="${I18N.t('disk.new-file')}" data-action="new-file" id="disk-newfile-${cssEsc(diskPath)}">📄</button>
              <button class="btn btn-icon" title="${I18N.t('disk.upload-file')}" data-action="upload" id="disk-upload-${cssEsc(diskPath)}">⬆</button>
              <div class="disk-tree-divider"></div>
              <button class="btn btn-icon" title="${I18N.t('disk.expand-all')}" data-action="expand-all" id="disk-expand-all-${cssEsc(diskPath)}">⊞</button>
              <button class="btn btn-icon" title="${I18N.t('disk.collapse-all')}" data-action="collapse-all" id="disk-collapse-all-${cssEsc(diskPath)}">⊟</button>
            </div>
            <div class="disk-search-box">
              <input type="text" id="disk-search-${cssEsc(diskPath)}" placeholder="🔍 ${I18N.t('disk.search')}" value="${escapeHTML(session.searchQuery)}">
            </div>
          </div>
          <div class="disk-tree-body" id="disk-tree-${cssEsc(diskPath)}">
            <div class="disk-tree-row">${I18N.t('disk.loading')}</div>
          </div>
        </div>
        <div class="disk-file-viewer">
          <div class="disk-file-toolbar">
            <span id="disk-label-${cssEsc(diskPath)}">${I18N.t('disk.label-prefix')}${escapeHTML(diskPath)}</span>
            <div class="spacer"></div>
            <button class="btn" data-action="mirror" id="disk-mirror-${cssEsc(diskPath)}">${I18N.t('disk.mirror')}</button>
            <button class="btn btn-primary" data-action="unlock" id="disk-unlock-${cssEsc(diskPath)}">${I18N.t('disk.unlock')}</button>
            <button class="btn" data-action="lock" id="disk-lock-${cssEsc(diskPath)}">${I18N.t('disk.lock')}</button>
            <button class="btn btn-warn" data-action="format" id="disk-format-${cssEsc(diskPath)}">${I18N.t('disk.format')}</button>
          </div>
          <div class="disk-mirror-status" id="disk-mirror-status-${cssEsc(diskPath)}" style="display:none"></div>
          <div class="disk-file-toolbar" id="disk-file-info-${cssEsc(diskPath)}">
            <span>${I18N.t('disk.no-file')}</span>
          </div>
          <div class="disk-progress" id="disk-progress-${cssEsc(diskPath)}" style="display:none">
            <div class="disk-progress-label">
              <span data-role="progress-text"></span>
              <span data-role="progress-pct"></span>
            </div>
            <div class="disk-progress-bar"><div class="disk-progress-fill" data-role="progress-fill"></div></div>
          </div>
          <pre class="disk-file-content" id="disk-content-${cssEsc(diskPath)}" contenteditable="false" spellcheck="false">
            <span style="color:#606060">${I18N.t('disk.select-file')}</span>
          </pre>
          <div class="disk-file-toolbar" id="disk-file-actions-${cssEsc(diskPath)}" style="display:none">
            <button class="btn btn-primary" data-action="save">${I18N.t('disk.save')}</button>
            <button class="btn" data-action="download">${I18N.t('disk.download')}</button>
            <button class="btn" data-action="delete">${I18N.t('disk.delete')}</button>
          </div>
        </div>
      </div>
    `;

    // 绑定工具栏按钮
    pane.querySelector(`#disk-mirror-${cssEsc(diskPath)}`).addEventListener('click', () => openMirrorDialog(diskPath, vm));
    pane.querySelector(`#disk-unlock-${cssEsc(diskPath)}`).addEventListener('click', () => unlock(diskPath));
    pane.querySelector(`#disk-lock-${cssEsc(diskPath)}`).addEventListener('click', () => lock(diskPath));
    pane.querySelector(`#disk-format-${cssEsc(diskPath)}`).addEventListener('click', () => format(diskPath));

    const actionsBar = pane.querySelector(`#disk-file-actions-${cssEsc(diskPath)}`);
    actionsBar.querySelector('button[data-action="save"]').addEventListener('click', () => saveCurrent(diskPath));
    actionsBar.querySelector('button[data-action="download"]').addEventListener('click', () => downloadCurrent(diskPath));
    actionsBar.querySelector('button[data-action="delete"]').addEventListener('click', () => deleteCurrent(diskPath));

    // 文件树操作按钮
    pane.querySelector(`#disk-newfolder-${cssEsc(diskPath)}`).addEventListener('click', () => newItemDialog(diskPath, 'folder'));
    pane.querySelector(`#disk-newfile-${cssEsc(diskPath)}`).addEventListener('click', () => newItemDialog(diskPath, 'file'));
    pane.querySelector(`#disk-upload-${cssEsc(diskPath)}`).addEventListener('click', async () => {
      const session = getSession(diskPath);
      if (session.info && session.info.locked) {
        alert(I18N.t('disk.locked-alert'));
        return;
      }
      const targetDir = await pickDirectory(diskPath, session.currentDir || '/');
      if (targetDir == null) return;
      openFilePicker(diskPath, targetDir);
    });
    pane.querySelector(`#disk-expand-all-${cssEsc(diskPath)}`).addEventListener('click', () => expandAll(diskPath));
    pane.querySelector(`#disk-collapse-all-${cssEsc(diskPath)}`).addEventListener('click', () => collapseAll(diskPath));

    // 搜索框
    const searchInput = pane.querySelector(`#disk-search-${cssEsc(diskPath)}`);
    searchInput.addEventListener('input', (e) => {
      const session = getSession(diskPath);
      session.searchQuery = e.target.value;
      renderTree(diskPath);
    });

    // 加载信息
    loadInfo(diskPath);
    // 加载镜像状态
    loadMirrorStatus(diskPath, vm);
  }

  function cssEsc(s) { return s.replace(/[^a-z0-9_-]/gi, '-'); }
  function cssEscAttr(s) { return CSS.escape(s); }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function diskApiPath(diskPath) {
    // 转换为 URL 段 (相对路径, 比如 "vms/MyVM/disk1.ocd" -> "vms/MyVM/disk1.ocd")
    return encodeURIComponent(diskPath);
  }

  async function loadInfo(diskPath) {
    try {
      const info = await App.api(`disks/${diskApiPath(diskPath)}/info`);
      const session = getSession(diskPath);
      session.info = info;
      if (info.locked) {
        renderLocked(diskPath);
      } else {
        renderUnlocked(diskPath);
        loadTree(diskPath);
      }
    } catch (e) {
      setStatus(diskPath, I18N.t('disk.load-failed') + e.message);
    }
  }

  function renderLocked(diskPath) {
    const treeEl = document.getElementById(`disk-tree-${cssEsc(diskPath)}`);
    treeEl.innerHTML = `
      <div style="padding: 12px; text-align: center; color: var(--fg-muted);">
        🔒 ${I18N.t('disk.locked-title')}<br>
        <span style="color: var(--fg-dim)">${I18N.t('disk.locked-hint')}</span>
      </div>
    `;
    document.getElementById(`disk-unlock-${cssEsc(diskPath)}`).disabled = false;
    document.getElementById(`disk-lock-${cssEsc(diskPath)}`).disabled = true;
    document.getElementById(`disk-format-${cssEsc(diskPath)}`).disabled = false;
  }

  function renderUnlocked(diskPath) {
    document.getElementById(`disk-unlock-${cssEsc(diskPath)}`).disabled = true;
    document.getElementById(`disk-lock-${cssEsc(diskPath)}`).disabled = false;
    document.getElementById(`disk-format-${cssEsc(diskPath)}`).disabled = false;
  }

  async function loadTree(diskPath) {
    try {
      const tree = await App.api(`disks/${diskApiPath(diskPath)}/tree`);
      const session = getSession(diskPath);
      session.tree = tree;
      renderTree(diskPath);
    } catch (e) {
      setStatus(diskPath, I18N.t('disk.tree-failed') + e.message);
    }
  }

  function renderTree(diskPath) {
    const session = getSession(diskPath);
    const treeEl = document.getElementById(`disk-tree-${cssEsc(diskPath)}`);
    treeEl.innerHTML = '';
    if (!session.tree) {
      treeEl.innerHTML = `<div class="disk-tree-row">${I18N.t('disk.empty')}</div>`;
      return;
    }
    const query = session.searchQuery.trim().toLowerCase();
    if (query) {
      // 搜索模式: 收集所有匹配的文件和文件夹
      const matches = [];
      collectMatches(session.tree, '', query, matches);
      if (matches.length === 0) {
        treeEl.innerHTML = `<div class="disk-tree-row" style="color:var(--fg-dim)">${I18N.t('disk.no-match')}</div>`;
        return;
      }
      // 按路径排序显示
      matches.sort((a, b) => a.path.localeCompare(b.path));
      for (const m of matches) {
        const row = document.createElement('div');
        row.className = 'disk-tree-row ' + (m.type === 'dir' ? 'dir' : 'file') + ' search-result';
        row.innerHTML = `<span class="icon"></span><span class="name"></span><span class="path-hint"></span>`;
        row.querySelector('.name').textContent = m.name;
        row.querySelector('.path-hint').textContent = m.path;
        row.dataset.path = m.path;
        row.dataset.type = m.type;
        if (m.type === 'file') {
          row.addEventListener('click', () => {
            // 找到这个文件, 展开其父目录
            const parentPath = m.path.substring(0, m.path.lastIndexOf('/')) || '/';
            expandDirParents(diskPath, parentPath);
            selectFile(diskPath, m.path, row);
          });
        } else {
          row.addEventListener('click', () => {
            // 跳转到该文件夹, 展开它
            session.searchQuery = '';
            document.getElementById(`disk-search-${cssEsc(diskPath)}`).value = '';
            session.expandedDirs.add(m.path);
            expandDirParents(diskPath, m.path);
            renderTree(diskPath);
          });
        }
        treeEl.appendChild(row);
      }
    } else {
      // 正常树视图
      renderTreeNode(diskPath, treeEl, session.tree, '', 0);
    }
  }

  // 收集搜索匹配的节点
  function collectMatches(node, parentPath, query, results) {
    if (!node || !node.children) return;
    const children = getChildrenArray(node);
    for (const child of children) {
      const childPath = parentPath ? `${parentPath}/${child.name}` : '/' + child.name;
      const nameLower = child.name.toLowerCase();
      if (nameLower.includes(query)) {
        results.push({ name: child.name, path: childPath, type: child.type });
      }
      if (child.type === 'dir' && child.children) {
        collectMatches(child, childPath, query, results);
      }
    }
  }

  // 统一获取子节点数组 (兼容数组和对象两种格式)
  function getChildrenArray(node) {
    if (!node || !node.children) return [];
    if (Array.isArray(node.children)) return node.children;
    return Object.values(node.children);
  }

  // 展开某路径的所有父目录
  function expandDirParents(diskPath, dirPath) {
    const session = getSession(diskPath);
    const parts = dirPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      session.expandedDirs.add(current);
    }
  }

  function renderTreeNode(diskPath, parentEl, node, parentPath, depth) {
    if (!node || !node.children) return;
    const session = getSession(diskPath);
    // 按名称排序: 文件夹在前, 文件在后
    const children = getChildrenArray(node);
    const sorted = [...children].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of sorted) {
      const childPath = parentPath ? `${parentPath}/${child.name}` : '/' + child.name;
      const row = document.createElement('div');
      row.className = 'disk-tree-row ' + (child.type === 'dir' ? 'dir' : 'file');
      row.style.paddingLeft = (depth * 12 + 6) + 'px';
      row.innerHTML = `<span class="twisty"></span><span class="icon"></span><span class="name"></span>`;
      row.querySelector('.name').textContent = child.name;
      if (child.size != null) {
        row.querySelector('.name').textContent += ` (${formatSize(child.size)})`;
      }
      // 在节点上记录完整路径
      row.dataset.path = childPath;
      row.dataset.type = child.type;
      if (child.type === 'file') {
        row.addEventListener('click', () => selectFile(diskPath, childPath, row));
      } else {
        const isExpanded = session.expandedDirs.has(childPath);
        if (isExpanded) row.classList.add('expanded');
        row.querySelector('.twisty').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleDir(diskPath, childPath, row);
        });
        row.addEventListener('click', () => {
          toggleDir(diskPath, childPath, row);
        });
      }
      parentEl.appendChild(row);
      if (child.type === 'dir' && child.children) {
        const childContainer = document.createElement('div');
        childContainer.className = 'disk-tree-node';
        childContainer.dataset.dirPath = childPath;
        if (!session.expandedDirs.has(childPath)) {
          childContainer.style.display = 'none';
        }
        parentEl.appendChild(childContainer);
        renderTreeNode(diskPath, childContainer, child, childPath, depth + 1);
      }
    }
  }

  function toggleDir(diskPath, dirPath, rowEl) {
    const session = getSession(diskPath);
    const treeEl = document.getElementById(`disk-tree-${cssEsc(diskPath)}`);
    const childContainer = treeEl.querySelector(`.disk-tree-node[data-dir-path="${cssEscAttr(dirPath)}"]`);
    if (session.expandedDirs.has(dirPath)) {
      session.expandedDirs.delete(dirPath);
      rowEl.classList.remove('expanded');
      if (childContainer) childContainer.style.display = 'none';
    } else {
      session.expandedDirs.add(dirPath);
      session.currentDir = dirPath;
      rowEl.classList.add('expanded');
      if (childContainer) childContainer.style.display = '';
    }
  }

  function expandAll(diskPath) {
    const session = getSession(diskPath);
    // 收集所有文件夹路径
    const allDirs = [];
    function walk(node, parentPath) {
      const children = getChildrenArray(node);
      for (const child of children) {
        const childPath = parentPath ? `${parentPath}/${child.name}` : '/' + child.name;
        if (child.type === 'dir') {
          allDirs.push(childPath);
          walk(child, childPath);
        }
      }
    }
    walk(session.tree, '');
    for (const d of allDirs) session.expandedDirs.add(d);
    renderTree(diskPath);
  }

  function collapseAll(diskPath) {
    const session = getSession(diskPath);
    session.expandedDirs.clear();
    renderTree(diskPath);
  }

  async function selectFile(diskPath, innerPath, rowEl) {
    const session = getSession(diskPath);
    session.selectedFile = innerPath;
    session.selectedPath = innerPath;
    session.currentDir = parentOf(innerPath);
    // 标记 active
    document.querySelectorAll(`#disk-tree-${cssEsc(diskPath)} .disk-tree-row`).forEach(r => r.classList.remove('active'));
    rowEl.classList.add('active');
    document.getElementById(`disk-file-info-${cssEsc(diskPath)}`).innerHTML = `<span>${escapeHTML(innerPath)}${I18N.t('disk.loading-file')}</span>`;
    try {
      const result = await App.api(`disks/${diskApiPath(diskPath)}/read?path=${encodeURIComponent(innerPath)}`);
      const contentEl = document.getElementById(`disk-content-${cssEsc(diskPath)}`);
      if (result && result.type === 'file') {
        contentEl.textContent = result.content || '';
        contentEl.setAttribute('contenteditable', 'true');
        contentEl.dataset.path = innerPath;
        document.getElementById(`disk-file-actions-${cssEsc(diskPath)}`).style.display = '';
        document.getElementById(`disk-file-info-${cssEsc(diskPath)}`).innerHTML =
          `<span>${escapeHTML(innerPath)} - ${formatSize((result.content || '').length)}</span>`;
        session.selectedPath = innerPath;
      } else if (result && result.type === 'dir') {
        contentEl.textContent = I18N.t('disk.directory');
        contentEl.setAttribute('contenteditable', 'false');
        document.getElementById(`disk-file-actions-${cssEsc(diskPath)}`).style.display = 'none';
      } else {
        document.getElementById(`disk-file-info-${cssEsc(diskPath)}`).innerHTML =
          `<span style="color:var(--err)">${result?.error || I18N.t('disk.read-failed')}</span>`;
      }
    } catch (e) {
      document.getElementById(`disk-file-info-${cssEsc(diskPath)}`).innerHTML =
        `<span style="color:var(--err)">${e.message}</span>`;
    }
  }

  async function saveCurrent(diskPath) {
    const session = getSession(diskPath);
    if (!session.selectedPath) return;
    const contentEl = document.getElementById(`disk-content-${cssEsc(diskPath)}`);
    const content = contentEl.textContent;
    try {
      await App.api(`disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(session.selectedPath)}`, {
        method: 'PUT',
        body: { content },
      });
      // 刷新
      await loadTree(diskPath);
      App.setStatus(I18N.t('disk.saved').replace('{path}', session.selectedPath));
    } catch (e) {
      alert(I18N.t('disk.save-failed') + ': ' + e.message);
    }
  }

  async function deleteCurrent(diskPath) {
    const session = getSession(diskPath);
    if (!session.selectedPath) return;
    if (!confirm(I18N.t('disk.confirm-delete').replace('{path}', session.selectedPath))) return;
    try {
      await App.api(`disks/${diskApiPath(diskPath)}/remove?path=${encodeURIComponent(session.selectedPath)}`, {
        method: 'DELETE',
      });
      document.getElementById(`disk-content-${cssEsc(diskPath)}`).textContent = I18N.t('disk.deleted');
      await loadTree(diskPath);
    } catch (e) {
      alert(I18N.t('disk.delete-failed') + ': ' + e.message);
    }
  }

  // 下载当前文件: 边读边显示进度, 完成后保存到本地
  async function downloadCurrent(diskPath) {
    const session = getSession(diskPath);
    const innerPath = session.selectedPath;
    if (!innerPath) return;
    const name = innerPath.substring(innerPath.lastIndexOf('/') + 1) || 'download';
    const url = `disks/${diskApiPath(diskPath)}/download?path=${encodeURIComponent(innerPath)}`;
    try {
      showProgress(diskPath, `${I18N.t('disk.downloading')} ${name}`, null);
      const res = await fetch('/api/' + url);
      if (!res.ok) {
        let message = 'HTTP ' + res.status;
        try {
          const data = await res.json();
          if (data && data.error) message = data.error;
        } catch {
          /* 响应不是 JSON 时保留状态码 */
        }
        throw new Error(message);
      }
      const total = Number(res.headers.get('Content-Length')) || 0;
      let blob;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
          }
          const sizeText = total > 0
            ? `${formatSize(received)} / ${formatSize(total)}`
            : formatSize(received);
          showProgress(diskPath, `${I18N.t('disk.downloading')} ${name} ${sizeText}`,
            total > 0 ? (received / total) * 100 : null);
        }
        blob = new Blob(chunks, { type: 'application/octet-stream' });
      } else {
        blob = await res.blob();
      }
      triggerDownload(blob, name);
      App.setStatus(I18N.t('disk.download-done', { name }));
    } catch (e) {
      alert(I18N.t('disk.download-failed') + ': ' + e.message);
    } finally {
      hideProgress(diskPath);
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function unlock(diskPath) {
    try {
      await App.api(`disks/${diskApiPath(diskPath)}/unlock`, { method: 'POST' });
      await loadInfo(diskPath);
      App.setStatus(I18N.t('disk.unlocked'));
    } catch (e) {
      alert(I18N.t('disk.unlock-failed') + ': ' + e.message);
    }
  }

  async function lock(diskPath) {
    try {
      await App.api(`disks/${diskApiPath(diskPath)}/lock`, { method: 'POST' });
      await loadInfo(diskPath);
      App.setStatus(I18N.t('disk.locked'));
    } catch (e) {
      alert(I18N.t('disk.lock-failed') + ': ' + e.message);
    }
  }

  async function format(diskPath) {
    if (!confirm(I18N.t('disk.format-confirm'))) return;
    try {
      await App.api(`disks/${diskApiPath(diskPath)}/format`, { method: 'POST' });
      await loadInfo(diskPath);
      App.setStatus(I18N.t('disk.formatted'));
    } catch (e) {
      alert(I18N.t('disk.format-failed') + ': ' + e.message);
    }
  }

  function setStatus(diskPath, text) {
    App.setStatus(text);
  }

  // ---------- 进度显示 ----------

  function progressBox(diskPath) {
    return document.getElementById(`disk-progress-${cssEsc(diskPath)}`);
  }

  // percent 为 null 时显示不确定进度 (滑块动画)
  function showProgress(diskPath, text, percent) {
    const box = progressBox(diskPath);
    if (!box) return;
    box.style.display = '';
    const label = box.querySelector('[data-role="progress-text"]');
    const pct = box.querySelector('[data-role="progress-pct"]');
    const fill = box.querySelector('[data-role="progress-fill"]');
    if (label) label.textContent = text;
    const known = typeof percent === 'number' && Number.isFinite(percent);
    box.classList.toggle('indeterminate', !known);
    if (known) {
      const value = Math.max(0, Math.min(100, percent));
      if (pct) pct.textContent = Math.round(value) + '%';
      if (fill) fill.style.width = value + '%';
    } else {
      if (pct) pct.textContent = '';
      if (fill) fill.style.width = '';
    }
  }

  function hideProgress(diskPath) {
    const box = progressBox(diskPath);
    if (!box) return;
    box.style.display = 'none';
    box.classList.remove('indeterminate');
  }

  // ---------- 目录选择 ----------

  function parentOf(dirPath) {
    if (!dirPath || dirPath === '/') return '/';
    const index = dirPath.lastIndexOf('/');
    return index <= 0 ? '/' : dirPath.substring(0, index);
  }

  function joinPath(dirPath, name) {
    return (dirPath === '/' ? '' : dirPath) + '/' + name;
  }

  function nodeAtPath(root, dirPath) {
    if (!root) return null;
    if (!dirPath || dirPath === '/') return root;
    let node = root;
    for (const part of dirPath.split('/').filter(Boolean)) {
      const next = getChildrenArray(node).find(child => child.type === 'dir' && child.name === part);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  function listSubDirs(diskPath, dirPath) {
    const node = nodeAtPath(getSession(diskPath).tree, dirPath);
    if (!node) return [];
    return getChildrenArray(node)
      .filter(child => child.type === 'dir')
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // 弹出目录选择框; 返回选中的路径, 取消时返回 null
  function pickDirectory(diskPath, startPath) {
    return new Promise((resolve) => {
      let current = startPath && startPath !== '' ? startPath : '/';
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>${I18N.t('disk.choose-dir-title')}</h3>
            <button class="modal-close" data-action="close">×</button>
          </div>
          <div class="modal-body">
            <div class="dir-picker-path">
              <button class="btn btn-icon" data-action="up" title="${I18N.t('disk.up')}">⬆</button>
              <span id="dir-picker-current"></span>
            </div>
            <div class="dir-picker-list" id="dir-picker-list"></div>
          </div>
          <div class="modal-footer">
            <button class="btn" data-action="cancel">${I18N.t('disk.cancel')}</button>
            <button class="btn btn-primary" data-action="choose">${I18N.t('disk.choose-this-dir')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const currentEl = modal.querySelector('#dir-picker-current');
      const listEl = modal.querySelector('#dir-picker-list');

      function renderList() {
        currentEl.textContent = current;
        listEl.innerHTML = '';
        const addRow = (label, target) => {
          const row = document.createElement('div');
          row.className = 'dir-picker-item';
          const icon = document.createElement('span');
          icon.textContent = '📁';
          const name = document.createElement('span');
          name.textContent = label;
          row.appendChild(icon);
          row.appendChild(name);
          row.addEventListener('click', () => {
            current = target;
            renderList();
          });
          listEl.appendChild(row);
        };
        if (current !== '/') addRow('..', parentOf(current));
        const dirs = listSubDirs(diskPath, current);
        if (!dirs.length) {
          const empty = document.createElement('div');
          empty.className = 'dir-picker-empty';
          empty.textContent = I18N.t('disk.dir-empty');
          listEl.appendChild(empty);
        }
        for (const dir of dirs) addRow(dir.name, joinPath(current, dir.name));
      }

      function close(value) {
        modal.remove();
        resolve(value == null ? null : value);
      }

      renderList();
      modal.querySelector('[data-action="up"]').addEventListener('click', () => {
        current = parentOf(current);
        renderList();
      });
      modal.querySelector('[data-action="choose"]').addEventListener('click', () => close(current));
      modal.querySelector('[data-action="close"]').addEventListener('click', () => close(null));
      modal.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      modal.querySelector('.modal-backdrop').addEventListener('click', () => close(null));
    });
  }

  // ---------- 新建文件/文件夹 ----------

  function newItemDialog(diskPath, type) {
    const session = getSession(diskPath);
    if (session.info?.locked) {
      alert(I18N.t('disk.locked-alert'));
      return;
    }
    // 默认父目录: 当前浏览的目录
    const parentDir = session.currentDir || '/';

    const isFolder = type === 'folder';
    const title = isFolder ? I18N.t('disk.new-folder') : I18N.t('disk.new-file');
    const placeholder = isFolder ? I18N.t('disk.folder-name') : I18N.t('disk.file-name-placeholder');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-dialog">
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="modal-close" data-action="close">×</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>${I18N.t('disk.parent-dir')}</label>
            <div class="path-picker-row">
              <input type="text" id="new-item-parent" value="${escapeHTML(parentDir)}">
              <button type="button" class="btn" id="new-item-pick">${I18N.t('disk.select-dir')}</button>
            </div>
          </div>
          <div class="form-row">
            <label>${isFolder ? I18N.t('disk.name') : I18N.t('disk.file-name')}</label>
            <input type="text" id="new-item-name" placeholder="${placeholder}" autofocus>
          </div>
          <div class="form-warning" id="new-item-warning" style="display:none; color: var(--warn); font-size: 13px; margin-top: 8px;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="cancel">${I18N.t('disk.cancel')}</button>
          <button class="btn btn-primary" data-action="create">${I18N.t('disk.create')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const nameInput = modal.querySelector('#new-item-name');
    const parentInput = modal.querySelector('#new-item-parent');
    const warningEl = modal.querySelector('#new-item-warning');

    setTimeout(() => nameInput.focus(), 100);

    modal.querySelector('#new-item-pick').addEventListener('click', async () => {
      const picked = await pickDirectory(diskPath, parentInput.value.trim() || '/');
      if (picked != null) parentInput.value = picked;
    });

    function close() { modal.remove(); }

    modal.querySelector('[data-action="close"]').addEventListener('click', close);
    modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
    modal.querySelector('.modal-backdrop').addEventListener('click', close);

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
    });

    async function doCreate() {
      const name = nameInput.value.trim();
      const parent = parentInput.value.trim() || '/';
      if (!name) {
        warningEl.textContent = I18N.t('disk.name-empty');
        warningEl.style.display = '';
        return;
      }
      if (name.includes('/') || name.includes('\\')) {
        warningEl.textContent = I18N.t('disk.name-invalid');
        warningEl.style.display = '';
        return;
      }
      const fullPath = (parent === '/' ? '' : parent) + '/' + name;
      try {
        let result;
        if (isFolder) {
          result = await App.api(`disks/${diskApiPath(diskPath)}/mkdir`, {
            method: 'POST',
            body: { path: fullPath },
          });
        } else {
          result = await App.api(`disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(fullPath)}`, {
            method: 'PUT',
            body: { content: '' },
          });
        }
        if (result && result.error) throw new Error(result.error);
        // 展开父目录并刷新
        session.currentDir = parent;
        if (parent !== '/') {
          session.expandedDirs.add(parent);
          expandDirParents(diskPath, parent);
        }
        await loadTree(diskPath);
        App.setStatus((isFolder ? I18N.t('disk.created-folder') : I18N.t('disk.created-file')) + fullPath);
        close();
      } catch (e) {
        warningEl.textContent = e.message || I18N.t('disk.create-failed');
        warningEl.style.display = '';
      }
    }

    modal.querySelector('[data-action="create"]').addEventListener('click', doCreate);
  }

  // ---------- 上传文件 ----------

  // 选择本地文件后上传到指定目录
  let pendingFileInput = null;

  function openFilePicker(diskPath, targetDir) {
    if (pendingFileInput) {
      pendingFileInput.remove();
      pendingFileInput = null;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    pendingFileInput = input;
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : [];
      input.remove();
      pendingFileInput = null;
      if (files.length) handleFileUpload(diskPath, files, targetDir);
    });
    input.click();
  }

  async function handleFileUpload(diskPath, files, targetDir) {
    const session = getSession(diskPath);
    if (session.info?.locked) {
      alert(I18N.t('disk.locked-alert'));
      return;
    }
    if (!files || files.length === 0) return;

    const dir = targetDir && targetDir !== '' ? targetDir : '/';
    const list = Array.from(files);
    let successCount = 0;
    const errors = [];

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const innerPath = joinPath(dir, file.name);
      const prefix = `${I18N.t('disk.uploading')} ${i + 1}/${list.length}`;
      try {
        showProgress(diskPath, `${prefix} · ${file.name}`, null);
        const content = await readFileAsText(file);
        await uploadContent(diskPath, innerPath, content, (loaded, total) => {
          const overall = total > 0 ? ((i + loaded / total) / list.length) * 100 : null;
          showProgress(diskPath, `${prefix} · ${file.name}`, overall);
        });
        successCount++;
      } catch (e) {
        errors.push(file.name + ': ' + e.message);
      }
    }
    hideProgress(diskPath);

    // 展开目标目录并刷新
    session.currentDir = dir;
    if (dir !== '/') {
      session.expandedDirs.add(dir);
      expandDirParents(diskPath, dir);
    }
    await loadTree(diskPath);

    if (errors.length === 0) {
      App.setStatus(I18N.t('disk.uploaded', { n: successCount }));
    } else {
      App.setStatus(I18N.t('disk.upload-summary', { ok: successCount, fail: errors.length }));
      alert(I18N.t('disk.upload-failed') + '\n' + errors.join('\n'));
    }
  }

  // 用 XHR 上传, 以便读取上传字节进度
  function uploadContent(diskPath, innerPath, content, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(innerPath)}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText || 'null');
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && !(data && data.error)) resolve(data);
        else reject(new Error((data && data.error) || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = () => reject(new Error(I18N.t('disk.network-error')));
      xhr.send(JSON.stringify({ content: content == null ? '' : content }));
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  // ---------- 镜像模式 ----------

  async function loadMirrorStatus(diskPath, vm) {
    try {
      const status = await App.api(`disks/${diskApiPath(diskPath)}/mirror`);
      const session = getSession(diskPath);
      session.mirror = status;
      renderMirrorStatus(diskPath);
    } catch (e) {
      // 非 VM 磁盘（如模板磁盘）不支持镜像，忽略错误
      const statusEl = document.getElementById(`disk-mirror-status-${cssEsc(diskPath)}`);
      if (statusEl) statusEl.style.display = 'none';
    }
  }

  function renderMirrorStatus(diskPath) {
    const session = getSession(diskPath);
    const statusEl = document.getElementById(`disk-mirror-status-${cssEsc(diskPath)}`);
    if (!statusEl || !session.mirror) return;
    if (session.mirror.enabled) {
      statusEl.style.display = '';
      statusEl.innerHTML = `<span style="color: var(--ok)">${I18N.t('disk.mirror-enabled')}</span> <span style="color: var(--fg-dim); font-size: 12px;">${escapeHTML(session.mirror.path)}</span>`;
    } else {
      statusEl.style.display = 'none';
    }
  }

  function openMirrorDialog(diskPath, vm) {
    const session = getSession(diskPath);
    const enabled = session.mirror?.enabled || false;
    const currentPath = session.mirror?.path || '';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-dialog">
        <div class="modal-header">
          <h3>${I18N.t('disk.mirror-title')}</h3>
          <button class="modal-close" data-action="close">×</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>${I18N.t('disk.mirror-toggle')}</label>
            <label class="switch">
              <input type="checkbox" id="mirror-enabled" ${enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
          <div class="form-row" id="mirror-path-row" style="${enabled ? '' : 'display:none'}">
            <label>${I18N.t('disk.mirror-path')}</label>
            <div style="display:flex; flex-direction:column; gap:4px;">
              <input type="text" id="mirror-path-input" value="${escapeHTML(currentPath)}" placeholder="${escapeHTML(I18N.t('disk.mirror-path-placeholder'))}">
              <div class="hint">
                ${I18N.t('disk.mirror-hint')}
              </div>
            </div>
          </div>
          <div class="form-warning" id="mirror-warning" style="display:none; color: var(--warn); font-size: 13px; margin-top: 8px;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="cancel">${I18N.t('disk.cancel')}</button>
          <button class="btn btn-primary" data-action="save">${I18N.t('hw.save')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const enabledEl = modal.querySelector('#mirror-enabled');
    const pathRow = modal.querySelector('#mirror-path-row');
    const pathInput = modal.querySelector('#mirror-path-input');
    const warningEl = modal.querySelector('#mirror-warning');

    enabledEl.addEventListener('change', () => {
      pathRow.style.display = enabledEl.checked ? '' : 'none';
      warningEl.style.display = 'none';
    });

    function close() { modal.remove(); }

    modal.querySelector('[data-action="close"]').addEventListener('click', close);
    modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
    modal.querySelector('.modal-backdrop').addEventListener('click', close);

    modal.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const isEnabled = enabledEl.checked;
      const path = pathInput.value.trim();
      if (isEnabled && !path) {
        warningEl.textContent = I18N.t('disk.mirror-path-empty');
        warningEl.style.display = '';
        return;
      }
      try {
        const result = await App.api(`disks/${diskApiPath(diskPath)}/mirror`, {
          method: 'POST',
          body: { enabled: isEnabled, path },
        });
        session.mirror = result;
        renderMirrorStatus(diskPath);
        loadTree(diskPath);
        App.setStatus(I18N.t('disk.mirror-saved'));
        close();
      } catch (e) {
        warningEl.textContent = e.message || I18N.t('disk.save-failed');
        warningEl.style.display = '';
      }
    });
  }

  return { render };
})();

window.DiskEditor = DiskEditor;
