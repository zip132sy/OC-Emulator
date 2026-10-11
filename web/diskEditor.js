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
//   PUT    /api/disks/<path>/write?path= 写入内部文件
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
              <button class="btn btn-icon" title="新建文件夹" data-action="new-folder" id="disk-newfolder-${cssEsc(diskPath)}">📁</button>
              <button class="btn btn-icon" title="新建文件" data-action="new-file" id="disk-newfile-${cssEsc(diskPath)}">📄</button>
              <button class="btn btn-icon" title="上传文件" data-action="upload" id="disk-upload-${cssEsc(diskPath)}">⬆</button>
              <div class="disk-tree-divider"></div>
              <button class="btn btn-icon" title="全部展开" data-action="expand-all" id="disk-expand-all-${cssEsc(diskPath)}">⊞</button>
              <button class="btn btn-icon" title="全部折叠" data-action="collapse-all" id="disk-collapse-all-${cssEsc(diskPath)}">⊟</button>
            </div>
            <div class="disk-search-box">
              <input type="text" id="disk-search-${cssEsc(diskPath)}" placeholder="🔍 搜索文件…" value="${escapeHTML(session.searchQuery)}">
            </div>
          </div>
          <div class="disk-tree-body" id="disk-tree-${cssEsc(diskPath)}">
            <div class="disk-tree-row">加载中…</div>
          </div>
        </div>
        <div class="disk-file-viewer">
          <div class="disk-file-toolbar">
            <span id="disk-label-${cssEsc(diskPath)}">磁盘: ${escapeHTML(diskPath)}</span>
            <div class="spacer"></div>
            <button class="btn" data-action="mirror" id="disk-mirror-${cssEsc(diskPath)}">🪞 镜像模式</button>
            <button class="btn btn-primary" data-action="unlock" id="disk-unlock-${cssEsc(diskPath)}">🔓 解锁</button>
            <button class="btn" data-action="lock" id="disk-lock-${cssEsc(diskPath)}">🔒 锁定</button>
            <button class="btn btn-warn" data-action="format" id="disk-format-${cssEsc(diskPath)}">⚠ 格式化</button>
          </div>
          <div class="disk-mirror-status" id="disk-mirror-status-${cssEsc(diskPath)}" style="display:none"></div>
          <div class="disk-file-toolbar" id="disk-file-info-${cssEsc(diskPath)}">
            <span>未选择文件</span>
          </div>
          <pre class="disk-file-content" id="disk-content-${cssEsc(diskPath)}" contenteditable="false" spellcheck="false">
            <span style="color:#606060">选择左侧文件查看内容,或点击「解锁」启用编辑</span>
          </pre>
          <div class="disk-file-toolbar" id="disk-file-actions-${cssEsc(diskPath)}" style="display:none">
            <button class="btn btn-primary" data-action="save">💾 保存</button>
            <button class="btn" data-action="delete">🗑 删除</button>
          </div>
        </div>
      </div>
      <!-- 隐藏的文件上传 input -->
      <input type="file" id="disk-upload-input-${cssEsc(diskPath)}" style="display:none" multiple>
    `;

    // 绑定工具栏按钮
    pane.querySelector(`#disk-mirror-${cssEsc(diskPath)}`).addEventListener('click', () => openMirrorDialog(diskPath, vm));
    pane.querySelector(`#disk-unlock-${cssEsc(diskPath)}`).addEventListener('click', () => unlock(diskPath));
    pane.querySelector(`#disk-lock-${cssEsc(diskPath)}`).addEventListener('click', () => lock(diskPath));
    pane.querySelector(`#disk-format-${cssEsc(diskPath)}`).addEventListener('click', () => format(diskPath));

    const actionsBar = pane.querySelector(`#disk-file-actions-${cssEsc(diskPath)}`);
    actionsBar.querySelector('button[data-action="save"]').addEventListener('click', () => saveCurrent(diskPath));
    actionsBar.querySelector('button[data-action="delete"]').addEventListener('click', () => deleteCurrent(diskPath));

    // 文件树操作按钮
    pane.querySelector(`#disk-newfolder-${cssEsc(diskPath)}`).addEventListener('click', () => newItemDialog(diskPath, 'folder'));
    pane.querySelector(`#disk-newfile-${cssEsc(diskPath)}`).addEventListener('click', () => newItemDialog(diskPath, 'file'));
    pane.querySelector(`#disk-upload-${cssEsc(diskPath)}`).addEventListener('click', () => {
      document.getElementById(`disk-upload-input-${cssEsc(diskPath)}`).click();
    });
    pane.querySelector(`#disk-expand-all-${cssEsc(diskPath)}`).addEventListener('click', () => expandAll(diskPath));
    pane.querySelector(`#disk-collapse-all-${cssEsc(diskPath)}`).addEventListener('click', () => collapseAll(diskPath));

    // 上传文件选择
    document.getElementById(`disk-upload-input-${cssEsc(diskPath)}`).addEventListener('change', (e) => {
      handleFileUpload(diskPath, e.target.files);
      e.target.value = ''; // 重置以便再次选择同一文件
    });

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
      setStatus(diskPath, '加载失败: ' + e.message);
    }
  }

  function renderLocked(diskPath) {
    const treeEl = document.getElementById(`disk-tree-${cssEsc(diskPath)}`);
    treeEl.innerHTML = `
      <div style="padding: 12px; text-align: center; color: var(--fg-muted);">
        🔒 磁盘已锁定<br>
        <span style="color: var(--fg-dim)">默认情况下磁盘不可读,需要在控制面板中解锁</span>
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
      setStatus(diskPath, '加载文件树失败: ' + e.message);
    }
  }

  function renderTree(diskPath) {
    const session = getSession(diskPath);
    const treeEl = document.getElementById(`disk-tree-${cssEsc(diskPath)}`);
    treeEl.innerHTML = '';
    if (!session.tree) {
      treeEl.innerHTML = '<div class="disk-tree-row">空磁盘</div>';
      return;
    }
    const query = session.searchQuery.trim().toLowerCase();
    if (query) {
      // 搜索模式: 收集所有匹配的文件和文件夹
      const matches = [];
      collectMatches(session.tree, '', query, matches);
      if (matches.length === 0) {
        treeEl.innerHTML = '<div class="disk-tree-row" style="color:var(--fg-dim)">没有找到匹配的文件</div>';
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
    // 标记 active
    document.querySelectorAll(`#disk-tree-${cssEsc(diskPath)} .disk-tree-row`).forEach(r => r.classList.remove('active'));
    rowEl.classList.add('active');
    document.getElementById(`disk-file-info-${cssEsc(diskPath)}`).innerHTML = `<span>${escapeHTML(innerPath)} - 加载中…</span>`;
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

  // ---------- 新建文件/文件夹 ----------

  function newItemDialog(diskPath, type) {
    const session = getSession(diskPath);
    if (session.info?.locked) {
      alert('磁盘已锁定,请先解锁');
      return;
    }
    // 默认父目录: 当前选中的目录, 或根目录
    let parentDir = '/';
    if (session.selectedPath) {
      const selInfo = session.selectedFile;
      // 如果选中的是文件, 用它的父目录
      // 我们用路径判断: 先尝试读取选中项的类型
      const lastPart = session.selectedPath.substring(session.selectedPath.lastIndexOf('/') + 1);
      if (lastPart.includes('.')) {
        parentDir = session.selectedPath.substring(0, session.selectedPath.lastIndexOf('/')) || '/';
      } else {
        parentDir = session.selectedPath;
      }
    }

    const isFolder = type === 'folder';
    const title = isFolder ? '新建文件夹' : '新建文件';
    const placeholder = isFolder ? '文件夹名称' : '文件名 (如 test.lua)';

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
            <label>父目录</label>
            <input type="text" id="new-item-parent" value="${escapeHTML(parentDir)}" readonly style="background: var(--bg-top);">
          </div>
          <div class="form-row">
            <label>${isFolder ? '名称' : '文件名'}</label>
            <input type="text" id="new-item-name" placeholder="${placeholder}" autofocus>
          </div>
          <div class="form-warning" id="new-item-warning" style="display:none; color: var(--warn); font-size: 13px; margin-top: 8px;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="cancel">取消</button>
          <button class="btn btn-primary" data-action="create">创建</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const nameInput = modal.querySelector('#new-item-name');
    const parentInput = modal.querySelector('#new-item-parent');
    const warningEl = modal.querySelector('#new-item-warning');

    setTimeout(() => nameInput.focus(), 100);

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
        warningEl.textContent = '请输入名称';
        warningEl.style.display = '';
        return;
      }
      if (name.includes('/') || name.includes('\\')) {
        warningEl.textContent = '名称不能包含 / 或 \\';
        warningEl.style.display = '';
        return;
      }
      const fullPath = (parent === '/' ? '' : parent) + '/' + name;
      try {
        if (isFolder) {
          await App.api(`disks/${diskApiPath(diskPath)}/mkdir`, {
            method: 'POST',
            body: { path: fullPath },
          });
        } else {
          await App.api(`disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(fullPath)}`, {
            method: 'PUT',
            body: { content: '' },
          });
        }
        // 展开父目录并刷新
        if (parent !== '/') {
          session.expandedDirs.add(parent);
          expandDirParents(diskPath, parent);
        }
        await loadTree(diskPath);
        App.setStatus((isFolder ? '文件夹' : '文件') + '已创建: ' + fullPath);
        close();
      } catch (e) {
        warningEl.textContent = e.message || '创建失败';
        warningEl.style.display = '';
      }
    }

    modal.querySelector('[data-action="create"]').addEventListener('click', doCreate);
  }

  // ---------- 上传文件 ----------

  async function handleFileUpload(diskPath, files) {
    const session = getSession(diskPath);
    if (session.info?.locked) {
      alert('磁盘已锁定,请先解锁');
      return;
    }
    if (!files || files.length === 0) return;

    // 确定目标目录
    let targetDir = '/';
    if (session.selectedPath) {
      const sel = session.selectedPath;
      // 判断选中的是目录还是文件
      // 简化处理: 如果选中路径不含扩展名(粗略判断), 认为是目录
      const lastPart = sel.substring(sel.lastIndexOf('/') + 1);
      if (lastPart.includes('.')) {
        targetDir = sel.substring(0, sel.lastIndexOf('/')) || '/';
      } else {
        targetDir = sel;
      }
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    for (const file of files) {
      const innerPath = (targetDir === '/' ? '' : targetDir) + '/' + file.name;
      try {
        // 读取文件内容
        const content = await readFileAsText(file);
        await App.api(`disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(innerPath)}`, {
          method: 'PUT',
          body: { content },
        });
        successCount++;
      } catch (e) {
        failCount++;
        errors.push(file.name + ': ' + e.message);
      }
    }

    // 展开目标目录并刷新
    if (targetDir !== '/') {
      session.expandedDirs.add(targetDir);
      expandDirParents(diskPath, targetDir);
    }
    await loadTree(diskPath);

    if (failCount === 0) {
      App.setStatus(`已上传 ${successCount} 个文件`);
    } else {
      App.setStatus(`上传完成: ${successCount} 成功, ${failCount} 失败`);
      if (errors.length > 0) {
        console.warn('上传错误:', errors);
      }
    }
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
      statusEl.innerHTML = `<span style="color: var(--ok)">🪞 镜像模式已启用</span> <span style="color: var(--fg-dim); font-size: 12px;">${escapeHTML(session.mirror.path)}</span>`;
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
          <h3>镜像模式设置</h3>
          <button class="modal-close" data-action="close">×</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>启用镜像模式</label>
            <label class="switch">
              <input type="checkbox" id="mirror-enabled" ${enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
          <div class="form-row" id="mirror-path-row" style="${enabled ? '' : 'display:none'}">
            <label>镜像文件夹路径</label>
            <div style="display:flex; flex-direction:column; gap:4px;">
              <input type="text" id="mirror-path-input" value="${escapeHTML(currentPath)}" placeholder="如: cache/openos-download 或绝对路径">
              <div class="hint">
                镜像模式下，VM 启动前会将文件夹内容同步到磁盘，关闭后反向同步。<br>
                路径可以是相对路径（相对于项目根目录）或绝对路径。
              </div>
            </div>
          </div>
          <div class="form-warning" id="mirror-warning" style="display:none; color: var(--warn); font-size: 13px; margin-top: 8px;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="cancel">取消</button>
          <button class="btn btn-primary" data-action="save">保存</button>
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
        warningEl.textContent = '请输入镜像文件夹路径';
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
        App.setStatus('镜像模式设置已保存');
        close();
      } catch (e) {
        warningEl.textContent = e.message || '保存失败';
        warningEl.style.display = '';
      }
    });
  }

  return { render };
})();

window.DiskEditor = DiskEditor;
