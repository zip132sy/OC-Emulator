// ============================================================
// diskEditor.js - disk editor (VMware style)
//
// Usage: App.openTab({ type:'disk-editor', diskPath, vm, title })
// diskPath is relative to projectDir, e.g. "vms/MyVM/disk1.ocd"
//
// REST API:
//   GET    /api/disks/<path>/info        header info (body is not read)
//   POST   /api/disks/<path>/unlock     unlock the disk
//   POST   /api/disks/<path>/lock       lock the disk
//   GET    /api/disks/<path>/tree        file tree (only while unlocked)
//   GET    /api/disks/<path>/read?path=  read an inner file
//   GET    /api/disks/<path>/download?path= download an inner file (with Content-Length)
//   PUT    /api/disks/<path>/write?path= write an inner file
//   POST   /api/disks/<path>/mkdir       create a folder
//   DELETE /api/disks/<path>/remove?path= delete an inner file
//   POST   /api/disks/<path>/format     format the disk
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
        expandedDirs: new Set(), // expanded folder paths
        searchQuery: '',         // search query
        currentDir: '/',         // current folder (default target for uploads and new items)
        clipboard: null,         // pending copy / cut payload { mode, path, type }
        groupCollapsed: { dirs: false, files: false }, // collapsed state of the tree groups (folders / files)
        uploadListCollapsed: false, // collapsed state of the upload list
        uploadItems: [],         // upload list entries [{ name, path, status, percent, error }]
        uploadDone: 0,           // number of completed uploads
        uploadFailed: 0,         // number of failed uploads
      });
    }
    return sessions.get(diskPath);
  }

  function render(pane, diskPath, vm) {
    const session = getSession(diskPath);
    pane.innerHTML = `
      <div class="disk-editor" id="disk-editor-${cssEsc(diskPath)}">
        <div class="disk-tree">
          <div class="disk-tree-header">
            <div class="disk-tree-actions">
              <button class="btn btn-icon" title="${I18N.t('disk.new-folder')}" data-action="new-folder" id="disk-newfolder-${cssEsc(diskPath)}">📁</button>
              <button class="btn btn-icon" title="${I18N.t('disk.new-file')}" data-action="new-file" id="disk-newfile-${cssEsc(diskPath)}">📄</button>
              <button class="btn btn-icon" title="${I18N.t('disk.upload-file')}" data-action="upload" id="disk-upload-${cssEsc(diskPath)}">⬆</button>
              <div class="disk-tree-divider"></div>
              <button class="btn disk-tree-lock-btn" data-action="unlock" id="disk-tree-unlock-${cssEsc(diskPath)}" title="${I18N.t('disk.unlock')}">${I18N.t('disk.unlock')}</button>
              <button class="btn disk-tree-lock-btn" data-action="lock" id="disk-tree-lock-${cssEsc(diskPath)}" title="${I18N.t('disk.lock')}">${I18N.t('disk.lock')}</button>
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
            <button class="btn btn-icon disk-viewer-close" data-action="close-viewer" id="disk-close-viewer-${cssEsc(diskPath)}" title="${I18N.t('disk.close-viewer')}">✕</button>
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
          <div class="disk-upload-list" id="disk-upload-list-${cssEsc(diskPath)}" style="display:none">
            <div class="disk-upload-header" id="disk-upload-header-${cssEsc(diskPath)}" title="${I18N.t('disk.upload-list-toggle')}">
              <span class="twisty"></span>
              <span class="disk-upload-title">${I18N.t('disk.upload-list')}</span>
              <span class="disk-upload-summary" data-role="upload-summary"></span>
            </div>
            <div class="disk-upload-body" id="disk-upload-body-${cssEsc(diskPath)}"></div>
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

    pane.querySelector(`#disk-mirror-${cssEsc(diskPath)}`).addEventListener('click', () => openMirrorDialog(diskPath, vm));
    pane.querySelector(`#disk-unlock-${cssEsc(diskPath)}`).addEventListener('click', () => unlock(diskPath));
    pane.querySelector(`#disk-lock-${cssEsc(diskPath)}`).addEventListener('click', () => lock(diskPath));
    pane.querySelector(`#disk-format-${cssEsc(diskPath)}`).addEventListener('click', () => format(diskPath));
    const closeViewerBtn = pane.querySelector(`#disk-close-viewer-${cssEsc(diskPath)}`);
    if (closeViewerBtn) closeViewerBtn.addEventListener('click', () => closeViewer(diskPath));
    // On mobile the content area floats, so the tree header also offers lock / unlock
    pane.querySelector(`#disk-tree-unlock-${cssEsc(diskPath)}`).addEventListener('click', () => unlock(diskPath));
    pane.querySelector(`#disk-tree-lock-${cssEsc(diskPath)}`).addEventListener('click', () => lock(diskPath));

    const actionsBar = pane.querySelector(`#disk-file-actions-${cssEsc(diskPath)}`);
    actionsBar.querySelector('button[data-action="save"]').addEventListener('click', () => saveCurrent(diskPath));
    actionsBar.querySelector('button[data-action="download"]').addEventListener('click', () => downloadCurrent(diskPath));
    actionsBar.querySelector('button[data-action="delete"]').addEventListener('click', () => deleteCurrent(diskPath));

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

    const searchInput = pane.querySelector(`#disk-search-${cssEsc(diskPath)}`);
    searchInput.addEventListener('input', (e) => {
      const session = getSession(diskPath);
      session.searchQuery = e.target.value;
      renderTree(diskPath);
    });

    const treeBody = pane.querySelector(`#disk-tree-${cssEsc(diskPath)}`);
    treeBody.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.disk-tree-row');
      if (!row || !row.dataset.path) return;
      e.preventDefault();
      openContextMenu(diskPath, e.clientX, e.clientY, row.dataset.path, row.dataset.type, row);
    });

    // Upload list: the header toggles collapse; restore the previous upload records
    const uploadHeader = pane.querySelector(`#disk-upload-header-${cssEsc(diskPath)}`);
    if (uploadHeader) {
      uploadHeader.addEventListener('click', () => toggleUploadList(diskPath));
    }
    if (session.uploadItems.length) {
      showUploadList(diskPath);
    }

    loadInfo(diskPath);
    loadMirrorStatus(diskPath, vm);
  }

  function cssEsc(s) { return s.replace(/[^a-z0-9_-]/gi, '-'); }
  function cssEscAttr(s) { return CSS.escape(s); }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function diskApiPath(diskPath) {
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
    syncLockButtons(diskPath, true);
  }

  function renderUnlocked(diskPath) {
    syncLockButtons(diskPath, false);
  }

  // Keep both lock buttons (content toolbar and tree header) in the same enabled state
  function syncLockButtons(diskPath, locked) {
    const states = [
      [`disk-unlock-${cssEsc(diskPath)}`, locked],
      [`disk-lock-${cssEsc(diskPath)}`, !locked],
      [`disk-tree-unlock-${cssEsc(diskPath)}`, locked],
      [`disk-tree-lock-${cssEsc(diskPath)}`, !locked],
    ];
    for (const [id, enabled] of states) {
      const el = document.getElementById(id);
      if (el) el.disabled = !enabled;
    }
    const formatEl = document.getElementById(`disk-format-${cssEsc(diskPath)}`);
    if (formatEl) formatEl.disabled = false;
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
      // Search mode: collect every matching file and folder
      const matches = [];
      collectMatches(session.tree, '', query, matches);
      if (matches.length === 0) {
        treeEl.innerHTML = `<div class="disk-tree-row" style="color:var(--fg-dim)">${I18N.t('disk.no-match')}</div>`;
        return;
      }
      // Sort by path and render grouped into folders / files
      matches.sort((a, b) => a.path.localeCompare(b.path));
      renderTreeGroups(diskPath, treeEl, matches, (body, m) => renderSearchRow(diskPath, body, m));
    } else {
      // Normal tree: root entries grouped into folders / files with collapsible headers
      const rootChildren = getChildrenArray(session.tree).sort(sortTreeChildren);
      renderTreeGroups(diskPath, treeEl, rootChildren, (body, child) => {
        renderTreeChild(diskPath, body, child, '', 0);
      });
    }
  }

  // Sort folders before files, then by name
  function sortTreeChildren(a, b) {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  }

  // Render folders / files as groups; clicking a header collapses or expands it
  function renderTreeGroups(diskPath, container, items, renderItem) {
    const session = getSession(diskPath);
    const groups = [
      { key: 'dirs', label: I18N.t('disk.group-folders'), items: items.filter(it => it.type === 'dir') },
      { key: 'files', label: I18N.t('disk.group-files'), items: items.filter(it => it.type === 'file') },
    ];
    for (const group of groups) {
      if (!group.items.length) continue;
      const collapsed = !!session.groupCollapsed[group.key];
      const header = document.createElement('div');
      header.className = 'disk-tree-group' + (collapsed ? '' : ' expanded');
      header.dataset.group = group.key;
      header.innerHTML = `<span class="twisty"></span><span class="group-name"></span><span class="group-count"></span>`;
      header.querySelector('.group-name').textContent = group.label;
      header.querySelector('.group-count').textContent = `(${group.items.length})`;
      header.addEventListener('click', () => {
        session.groupCollapsed[group.key] = !session.groupCollapsed[group.key];
        renderTree(diskPath);
      });
      container.appendChild(header);

      const body = document.createElement('div');
      body.className = 'disk-tree-group-body';
      if (collapsed) body.style.display = 'none';
      container.appendChild(body);
      for (const item of group.items) renderItem(body, item);
    }
  }

  // One search result row (shows the full path as a hint)
  function renderSearchRow(diskPath, container, m) {
    const session = getSession(diskPath);
    const row = document.createElement('div');
    row.className = 'disk-tree-row ' + (m.type === 'dir' ? 'dir' : 'file') + ' search-result';
    row.innerHTML = `<span class="icon"></span><span class="name"></span><span class="path-hint"></span>`;
    row.querySelector('.name').textContent = m.name;
    row.querySelector('.path-hint').textContent = m.path;
    row.dataset.path = m.path;
    row.dataset.type = m.type;
    if (m.type === 'file') {
      bindFileRow(diskPath, row, () => {
        // Reveal the file by expanding its parent folder
        const parentPath = m.path.substring(0, m.path.lastIndexOf('/')) || '/';
        expandDirParents(diskPath, parentPath);
        selectFile(diskPath, m.path, row);
      });
    } else {
      row.addEventListener('click', () => {
        // Jump to the folder and expand it
        session.searchQuery = '';
        document.getElementById(`disk-search-${cssEsc(diskPath)}`).value = '';
        session.expandedDirs.add(m.path);
        expandDirParents(diskPath, m.path);
        renderTree(diskPath);
      });
    }
    container.appendChild(row);
  }

  // Collect the nodes matching the query
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

  // Return children as an array (the server may send an array or an object)
  function getChildrenArray(node) {
    if (!node || !node.children) return [];
    if (Array.isArray(node.children)) return node.children;
    return Object.values(node.children);
  }

  // Expand every ancestor of the given path
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
    const children = getChildrenArray(node).sort(sortTreeChildren);
    for (const child of children) {
      renderTreeChild(diskPath, parentEl, child, parentPath, depth);
    }
  }

  // Render one node: its row plus a container for recursive child rows
  function renderTreeChild(diskPath, parentEl, child, parentPath, depth) {
    const session = getSession(diskPath);
    const childPath = parentPath ? `${parentPath}/${child.name}` : '/' + child.name;
    const row = document.createElement('div');
    row.className = 'disk-tree-row ' + (child.type === 'dir' ? 'dir' : 'file');
    row.style.paddingLeft = (depth * 12 + 6) + 'px';
    row.innerHTML = `<span class="twisty"></span><span class="icon"></span><span class="name"></span>`;
    row.querySelector('.name').textContent = child.name;
    if (child.size != null) {
      row.querySelector('.name').textContent += ` (${formatSize(child.size)})`;
    }
    row.dataset.path = childPath;
    row.dataset.type = child.type;
    if (child.type === 'file') {
      bindFileRow(diskPath, row, () => selectFile(diskPath, childPath, row));
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
    // Collect every folder path
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

  // On touch UIs a tap only highlights a file; a double tap opens it in the floating window
  function isTouchUi() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  function bindFileRow(diskPath, row, openFn) {
    let lastTapAt = 0;
    row.addEventListener('click', () => {
      if (!isTouchUi()) { openFn(); return; }
      const now = Date.now();
      if (now - lastTapAt <= 320) {
        lastTapAt = 0;
        openFn();
        return;
      }
      lastTapAt = now;
      document.querySelectorAll(`#disk-tree-${cssEsc(diskPath)} .disk-tree-row`).forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    });
  }

  // Close the floating content window (mobile)
  function closeViewer(diskPath) {
    const editorEl = document.getElementById(`disk-editor-${cssEsc(diskPath)}`);
    if (editorEl) editorEl.classList.remove('viewer-open');
    const session = getSession(diskPath);
    session.selectedFile = null;
    document.querySelectorAll(`#disk-tree-${cssEsc(diskPath)} .disk-tree-row`).forEach(r => r.classList.remove('active'));
  }

  async function selectFile(diskPath, innerPath, rowEl) {
    const session = getSession(diskPath);
    session.selectedFile = innerPath;
    session.selectedPath = innerPath;
    session.currentDir = parentOf(innerPath);
    document.querySelectorAll(`#disk-tree-${cssEsc(diskPath)} .disk-tree-row`).forEach(r => r.classList.remove('active'));
    rowEl.classList.add('active');
    // On mobile the content area floats; opening a file expands it
    const editorEl = document.getElementById(`disk-editor-${cssEsc(diskPath)}`);
    if (editorEl) editorEl.classList.add('viewer-open');
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
          `<span style="color:var(--err)">${(result && result.error) || I18N.t('disk.read-failed')}</span>`;
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
      const result = await App.api(`disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(session.selectedPath)}`, {
        method: 'PUT',
        body: { content },
      });
      if (result && result.error) throw new Error(result.error);
      await loadTree(diskPath);
      App.setStatus(I18N.t('disk.saved').replace('{path}', session.selectedPath));
    } catch (e) {
      alert(I18N.t('disk.save-failed') + ': ' + e.message);
    }
  }

  async function deleteCurrent(diskPath) {
    const session = getSession(diskPath);
    if (!session.selectedPath) return;
    await deletePath(diskPath, session.selectedPath);
  }

  // Delete a file or folder (folders recursively), then clear the selection and refresh the tree
  async function deletePath(diskPath, innerPath) {
    if (!confirm(I18N.t('disk.confirm-delete').replace('{path}', innerPath))) return;
    try {
      await removeInner(diskPath, innerPath);
      clearSelection(diskPath, innerPath);
      await loadTree(diskPath);
      App.setStatus(I18N.t('disk.deleted-path', { name: innerPath }));
    } catch (e) {
      alert(I18N.t('disk.delete-failed') + ': ' + e.message);
    }
  }

  // Clear the editor and action bar once the target is gone, so nothing touches a deleted file
  function clearSelection(diskPath, removedPath) {
    const session = getSession(diskPath);
    const selected = session.selectedPath;
    if (selected && (selected === removedPath || selected.startsWith(removedPath + '/'))) {
      session.selectedPath = null;
      session.selectedFile = null;
    }
    const contentEl = document.getElementById(`disk-content-${cssEsc(diskPath)}`);
    if (contentEl) {
      contentEl.textContent = I18N.t('disk.select-file');
      contentEl.setAttribute('contenteditable', 'false');
      contentEl.dataset.path = '';
    }
    const infoEl = document.getElementById(`disk-file-info-${cssEsc(diskPath)}`);
    if (infoEl) infoEl.innerHTML = `<span>${I18N.t('disk.no-file')}</span>`;
    const actions = document.getElementById(`disk-file-actions-${cssEsc(diskPath)}`);
    if (actions) actions.style.display = 'none';
  }

  // Download the selected file, reporting progress while streaming
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
          /* keep the status code when the response is not JSON */
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

  // ---------- Context menu: copy / cut / paste / delete ----------

  let contextMenuEl = null;
  let contextMenuClose = null;

  function closeContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.remove();
      contextMenuEl = null;
    }
    if (contextMenuClose) {
      document.removeEventListener('click', contextMenuClose, true);
      document.removeEventListener('keydown', contextMenuClose, true);
      window.removeEventListener('blur', contextMenuClose, true);
      contextMenuClose = null;
    }
  }

  function baseName(innerPath) {
    const path = String(innerPath || '');
    return path.substring(path.lastIndexOf('/') + 1) || path;
  }

  function findNode(root, targetPath) {
    if (!root) return null;
    if (!targetPath || targetPath === '/') return root;
    let node = root;
    for (const part of targetPath.split('/').filter(Boolean)) {
      const next = getChildrenArray(node).find(child => child.name === part);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  function openContextMenu(diskPath, x, y, innerPath, type, rowEl) {
    closeContextMenu();
    const session = getSession(diskPath);
    const isDir = type === 'dir';
    const items = [];

    items.push({
      label: I18N.t('disk.menu.open'),
      action: () => {
        if (isDir) toggleDir(diskPath, innerPath, rowEl);
        else selectFile(diskPath, innerPath, rowEl);
      },
    });
    items.push({
      label: I18N.t('disk.menu.copy'),
      action: () => {
        session.clipboard = { mode: 'copy', path: innerPath, type };
        App.setStatus(I18N.t('disk.menu.copied', { name: baseName(innerPath) }));
      },
    });
    items.push({
      label: I18N.t('disk.menu.cut'),
      action: () => {
        session.clipboard = { mode: 'cut', path: innerPath, type };
        App.setStatus(I18N.t('disk.menu.cut-done', { name: baseName(innerPath) }));
      },
    });
    items.push({
      label: I18N.t('disk.menu.paste'),
      disabled: !session.clipboard,
      action: () => pasteInto(diskPath, isDir ? innerPath : parentOf(innerPath)),
    });
    items.push({ separator: true });
    if (!isDir) {
      items.push({
        label: I18N.t('disk.download'),
        action: () => {
          session.selectedPath = innerPath;
          session.selectedFile = innerPath;
          downloadCurrent(diskPath);
        },
      });
    } else {
      items.push({
        label: I18N.t('disk.new-file'),
        action: () => {
          session.currentDir = innerPath;
          newItemDialog(diskPath, 'file');
        },
      });
      items.push({
        label: I18N.t('disk.new-folder'),
        action: () => {
          session.currentDir = innerPath;
          newItemDialog(diskPath, 'folder');
        },
      });
    }
    items.push({ separator: true });
    items.push({
      label: I18N.t('disk.delete'),
      danger: true,
      action: () => deletePath(diskPath, innerPath),
    });

    const menu = document.createElement('div');
    menu.className = 'disk-context-menu';
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'disk-context-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'disk-context-item' + (item.danger ? ' danger' : '');
      btn.textContent = item.label;
      btn.disabled = !!item.disabled;
      btn.addEventListener('click', () => {
        closeContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    contextMenuEl = menu;

    const openedAt = Date.now();
    contextMenuClose = (ev) => {
      if (ev && ev.type === 'keydown' && ev.key !== 'Escape') return;
      if (ev && ev.type === 'blur' && ev.target !== window) return;
      if (ev && ev.type === 'click') {
        // Let menu items handle their own clicks (removing the node during capture makes mobile lose the click)
        if (menu.contains(ev.target)) return;
        if (Date.now() - openedAt < 250) return;
      }
      closeContextMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', contextMenuClose, true);
      document.addEventListener('keydown', contextMenuClose, true);
      window.addEventListener('blur', contextMenuClose, true);
    }, 0);
  }

  // ---------- Copy / paste inside the disk ----------

  async function writeInner(diskPath, innerPath, content) {
    const result = await App.api(`disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(innerPath)}`, {
      method: 'PUT',
      body: { content },
    });
    if (result && result.error) throw new Error(result.error);
  }

  async function mkdirInner(diskPath, innerPath) {
    const result = await App.api(`disks/${diskApiPath(diskPath)}/mkdir`, {
      method: 'POST',
      body: { path: innerPath },
    });
    if (result && result.error) throw new Error(result.error);
  }

  async function removeInner(diskPath, innerPath) {
    const result = await App.api(`disks/${diskApiPath(diskPath)}/remove?path=${encodeURIComponent(innerPath)}`, {
      method: 'DELETE',
    });
    if (result && result.error) throw new Error(result.error);
  }

  async function copyDir(diskPath, srcPath, destPath) {
    const session = getSession(diskPath);
    const node = findNode(session.tree, srcPath);
    if (!node) throw new Error(I18N.t('disk.read-failed'));
    await mkdirInner(diskPath, destPath);
    for (const child of getChildrenArray(node)) {
      const srcChild = joinPath(srcPath, child.name);
      const destChild = joinPath(destPath, child.name);
      if (child.type === 'dir') {
        await copyDir(diskPath, srcChild, destChild);
      } else {
        const data = await App.api(`disks/${diskApiPath(diskPath)}/read?path=${encodeURIComponent(srcChild)}`);
        if (!data || data.type !== 'file') throw new Error((data && data.error) || I18N.t('disk.read-failed'));
        await writeInner(diskPath, destChild, data.content || '');
      }
    }
  }

  async function pasteInto(diskPath, targetDir) {
    const session = getSession(diskPath);
    const clip = session.clipboard;
    if (!clip) return;
    const name = baseName(clip.path);
    const dest = joinPath(targetDir, name);
    if (dest === clip.path) {
      alert(I18N.t('disk.menu.paste-same'));
      return;
    }
    if (clip.type === 'dir' && dest.startsWith(clip.path + '/')) {
      alert(I18N.t('disk.menu.paste-into-self'));
      return;
    }
    if (findNode(session.tree, dest)) {
      alert(I18N.t('disk.menu.paste-exists', { name }));
      return;
    }
    try {
      if (clip.type === 'file') {
        const data = await App.api(`disks/${diskApiPath(diskPath)}/read?path=${encodeURIComponent(clip.path)}`);
        if (!data || data.type !== 'file') throw new Error((data && data.error) || I18N.t('disk.read-failed'));
        await writeInner(diskPath, dest, data.content || '');
      } else {
        await copyDir(diskPath, clip.path, dest);
      }
      if (clip.mode === 'cut') {
        await removeInner(diskPath, clip.path);
        session.clipboard = null;
      }
      session.currentDir = targetDir;
      session.expandedDirs.add(targetDir);
      expandDirParents(diskPath, targetDir);
      await loadTree(diskPath);
      App.setStatus(I18N.t('disk.menu.pasted', { name }));
    } catch (e) {
      alert(I18N.t('disk.menu.paste-failed') + ': ' + e.message);
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

  // ---------- Progress display ----------

  function progressBox(diskPath) {
    return document.getElementById(`disk-progress-${cssEsc(diskPath)}`);
  }

  // A null percent shows an indeterminate (animated) bar
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

  // ---------- Upload list (per-file progress, collapsible) ----------

  function uploadListBox(diskPath) {
    return document.getElementById(`disk-upload-list-${cssEsc(diskPath)}`);
  }

  // Apply the collapsed state (header arrow and body visibility)
  function applyUploadListCollapsed(diskPath) {
    const session = getSession(diskPath);
    const box = uploadListBox(diskPath);
    if (!box) return;
    const header = box.querySelector('.disk-upload-header');
    if (header) header.classList.toggle('collapsed', session.uploadListCollapsed);
    const body = box.querySelector('.disk-upload-body');
    if (body) body.style.display = session.uploadListCollapsed ? 'none' : '';
  }

  // Header click collapses / expands the upload list
  function toggleUploadList(diskPath) {
    const session = getSession(diskPath);
    session.uploadListCollapsed = !session.uploadListCollapsed;
    applyUploadListCollapsed(diskPath);
  }

  // Show the upload list (keeping existing entries) and reapply the collapsed state
  function showUploadList(diskPath) {
    const box = uploadListBox(diskPath);
    if (!box) return;
    box.style.display = '';
    applyUploadListCollapsed(diskPath);
    renderUploadRows(diskPath);
    updateUploadSummary(diskPath);
  }

  // Start a new upload batch: rebuild the entries
  function startUploadList(diskPath, files) {
    const session = getSession(diskPath);
    if (session.uploadTicker) {
      clearInterval(session.uploadTicker);
      session.uploadTicker = null;
    }
    session.uploadItems = Array.from(files).map(f => ({
      name: f.name,
      path: null,
      status: 'pending',
      percent: null,
      phase: null,
      writeStartedAt: null,
      error: null,
    }));
    session.uploadDone = 0;
    session.uploadFailed = 0;
    showUploadList(diskPath);
  }

  function renderUploadRows(diskPath) {
    const session = getSession(diskPath);
    const body = document.getElementById(`disk-upload-body-${cssEsc(diskPath)}`);
    if (!body) return;
    body.innerHTML = '';
    session.uploadItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'disk-upload-row';
      row.dataset.idx = String(i);
      row.innerHTML = `
        <div class="disk-upload-row-top">
          <span class="disk-upload-name"></span>
          <span class="disk-upload-status"></span>
        </div>
        <div class="disk-upload-bar"><div class="disk-upload-fill"></div></div>
      `;
      const nameEl = row.querySelector('.disk-upload-name');
      nameEl.textContent = item.name;
      nameEl.title = item.path || item.name;
      body.appendChild(row);
      paintUploadRow(diskPath, i);
    });
  }

  function paintUploadRow(diskPath, index) {
    const session = getSession(diskPath);
    const item = session.uploadItems[index];
    if (!item) return;
    const row = document.querySelector(`#disk-upload-body-${cssEsc(diskPath)} .disk-upload-row[data-idx="${index}"]`);
    if (!row) return;
    const statusEl = row.querySelector('.disk-upload-status');
    const fillEl = row.querySelector('.disk-upload-fill');
    row.classList.remove('uploading', 'done', 'error', 'skipped', 'indeterminate');
    if (item.status === 'done') {
      row.classList.add('done');
      statusEl.textContent = '✓';
      fillEl.style.width = '100%';
    } else if (item.status === 'skipped') {
      row.classList.add('skipped');
      statusEl.textContent = I18N.t('disk.upload-skipped');
      fillEl.style.width = '0%';
    } else if (item.status === 'error') {
      row.classList.add('error');
      statusEl.textContent = '✗ ' + (item.error || I18N.t('disk.upload-failed'));
      fillEl.style.width = '100%';
    } else if (item.status === 'uploading') {
      row.classList.add('uploading');
      const pct = Number.isFinite(item.percent) ? Math.max(0, Math.min(100, item.percent)) : null;
      const phase = item.phase || 'sending';
      const label = phase === 'reading' ? I18N.t('disk.upload-reading')
        : phase === 'writing' ? I18N.t('disk.upload-writing')
        : I18N.t('disk.uploading');
      // Reading and sending report real percentages; the server write phase cannot, so show an indeterminate bar
      const indeterminate = phase === 'writing' || pct == null;
      row.classList.toggle('indeterminate', indeterminate);
      statusEl.textContent = indeterminate ? label : `${label} ${Math.round(pct)}%`;
      fillEl.style.width = indeterminate ? '' : pct + '%';
      if (phase === 'writing') ensureUploadTicker(diskPath);
    } else {
      statusEl.textContent = I18N.t('disk.upload-pending');
      fillEl.style.width = '0%';
    }
  }

  // Update one file's state / progress and repaint only that row
  function updateUploadItem(diskPath, index, patch) {
    const session = getSession(diskPath);
    const item = session.uploadItems[index];
    if (!item) return;
    Object.assign(item, patch);
    // Entering the server write phase: record the start time and tick elapsed time for real feedback
    if (patch.phase === 'writing' && !item.writeStartedAt) item.writeStartedAt = Date.now();
    if (patch.status && patch.status !== 'uploading') {
      item.writeStartedAt = null;
      stopUploadTicker(diskPath);
    }
    const row = document.querySelector(`#disk-upload-body-${cssEsc(diskPath)} .disk-upload-row[data-idx="${index}"]`);
    if (!row) {
      // The tab was rebuilt, so re-render the whole list
      renderUploadRows(diskPath);
      return;
    }
    const nameEl = row.querySelector('.disk-upload-name');
    if (patch.name) nameEl.textContent = patch.name;
    if (patch.path) nameEl.title = patch.path;
    paintUploadRow(diskPath, index);
  }

  // Update the header summary: done / total (failures)
  function updateUploadSummary(diskPath) {
    const session = getSession(diskPath);
    const box = uploadListBox(diskPath);
    if (!box) return;
    const el = box.querySelector('[data-role="upload-summary"]');
    if (!el) return;
    const total = session.uploadItems.length;
    const done = session.uploadItems.filter(it => it.status === 'done').length;
    const failed = session.uploadItems.filter(it => it.status === 'error').length;
    const skipped = session.uploadItems.filter(it => it.status === 'skipped').length;
    session.uploadDone = done;
    session.uploadFailed = failed;
    let text = `${done} / ${total}`;
    if (failed) text += ` · ${failed} ${I18N.t('disk.upload-failed-count')}`;
    if (skipped) text += ` · ${skipped} ${I18N.t('disk.upload-skipped-count')}`;
    el.textContent = text;
    box.classList.toggle('has-error', failed > 0);
  }

  // ---------- Write-phase timer (the server writes synchronously, so no percentage exists) ----------

  function formatElapsed(sec) {
    if (sec < 60) return sec.toFixed(1) + 's';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function writingItems(diskPath) {
    const session = getSession(diskPath);
    return session.uploadItems
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => item.status === 'uploading' && item.phase === 'writing');
  }

  function tickWritingRows(diskPath) {
    const session = getSession(diskPath);
    const rows = writingItems(diskPath);
    if (!rows.length) {
      if (session.uploadTicker) {
        clearInterval(session.uploadTicker);
        session.uploadTicker = null;
      }
      return;
    }
    for (const { item, i } of rows) {
      const row = document.querySelector(`#disk-upload-body-${cssEsc(diskPath)} .disk-upload-row[data-idx="${i}"]`);
      if (!row) continue;
      const statusEl = row.querySelector('.disk-upload-status');
      if (!statusEl) continue;
      const elapsed = item.writeStartedAt ? (Date.now() - item.writeStartedAt) / 1000 : 0;
      statusEl.textContent = `${I18N.t('disk.upload-writing')} ${formatElapsed(elapsed)}`;
    }
  }

  function ensureUploadTicker(diskPath) {
    const session = getSession(diskPath);
    if (session.uploadTicker) return;
    if (!writingItems(diskPath).length) return;
    session.uploadTicker = setInterval(() => tickWritingRows(diskPath), 200);
    tickWritingRows(diskPath);
  }

  function stopUploadTicker(diskPath) {
    const session = getSession(diskPath);
    if (session.uploadTicker && !writingItems(diskPath).length) {
      clearInterval(session.uploadTicker);
      session.uploadTicker = null;
    }
  }

  // ---------- Folder picking ----------

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

  // Open the folder picker; resolves to the chosen path, or null when cancelled
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

  // ---------- New file / folder ----------

  function newItemDialog(diskPath, type) {
    const session = getSession(diskPath);
    if (session.info && session.info.locked) {
      alert(I18N.t('disk.locked-alert'));
      return;
    }
    // Default parent folder: the one currently browsed
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
        // Expand the parent folder and refresh
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

  // ---------- Uploading files ----------

  // Pick local files and upload them into the target folder
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

  // Upload hit an existing file: ask to cancel / overwrite / rename
  function askUploadConflict(targetPath) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>${I18N.t('disk.upload-conflict-title')}</h3>
          </div>
          <div class="modal-body">
            <div class="disk-conflict-msg" data-role="message"></div>
          </div>
          <div class="modal-footer">
            <button class="btn" data-action="cancel">${I18N.t('disk.cancel')}</button>
            <button class="btn" data-action="rename">${I18N.t('disk.upload-conflict-rename')}</button>
            <button class="btn btn-primary" data-action="overwrite">${I18N.t('disk.upload-conflict-overwrite')}</button>
          </div>
        </div>
      `;
      modal.querySelector('[data-role="message"]').textContent =
        I18N.t('disk.upload-conflict-msg', { path: targetPath });
      document.body.appendChild(modal);

      let closed = false;
      function close(action) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(action);
      }
      function onKey(e) {
        if (e.key === 'Escape') close('cancel');
      }
      document.addEventListener('keydown', onKey);
      modal.querySelector('[data-action="cancel"]').addEventListener('click', () => close('cancel'));
      modal.querySelector('[data-action="rename"]').addEventListener('click', () => close('rename'));
      modal.querySelector('[data-action="overwrite"]').addEventListener('click', () => close('overwrite'));
      modal.querySelector('.modal-backdrop').addEventListener('click', () => close('cancel'));
    });
  }

  // Collect every file path in the tree
  function collectFilePaths(node, parentPath, out) {
    for (const child of getChildrenArray(node)) {
      const childPath = parentPath ? `${parentPath}/${child.name}` : '/' + child.name;
      if (child.type === 'file') {
        out.add(childPath);
      } else if (child.children) {
        collectFilePaths(child, childPath, out);
      }
    }
    return out;
  }

  // Generate a non-conflicting name: name_1.ext, name_2.ext, ...
  function makeUniqueName(name, dirPath, existingPaths) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${base}_${i}${ext}`;
      const candidatePath = joinPath(dirPath, candidate);
      if (!existingPaths.has(candidatePath)) {
        return { name: candidate, path: candidatePath };
      }
    }
  }

  async function handleFileUpload(diskPath, files, targetDir) {
    const session = getSession(diskPath);
    if (session.info && session.info.locked) {
      alert(I18N.t('disk.locked-alert'));
      return;
    }
    if (!files || files.length === 0) return;

    const dir = targetDir && targetDir !== '' ? targetDir : '/';
    const list = Array.from(files);
    let successCount = 0;
    const errors = [];

    // Refresh the tree first so existing names at the destination are detected
    await loadTree(diskPath);
    const existingPaths = collectFilePaths(session.tree, '', new Set());

    // Upload the files one by one, tracking each in the upload list
    startUploadList(diskPath, list);
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      let targetName = file.name;
      let innerPath = joinPath(dir, file.name);

      // Name conflict: ask to cancel / overwrite / rename
      if (existingPaths.has(innerPath)) {
        const action = await askUploadConflict(innerPath);
        if (action === 'cancel') {
          updateUploadItem(diskPath, i, { status: 'skipped' });
          updateUploadSummary(diskPath);
          continue;
        }
        if (action === 'rename') {
          const renamed = makeUniqueName(file.name, dir, existingPaths);
          targetName = renamed.name;
          innerPath = renamed.path;
          updateUploadItem(diskPath, i, { name: targetName, path: innerPath });
        }
      }

      // Three phases: local read 0-30%, sending 30-70%, server write (indeterminate)
      updateUploadItem(diskPath, i, { path: innerPath, status: 'uploading', phase: 'reading', percent: 0 });
      try {
        const content = await readFileAsText(file, (loaded, total) => {
          if (total > 0) updateUploadItem(diskPath, i, { percent: (loaded / total) * 30 });
        });
        updateUploadItem(diskPath, i, { phase: 'sending', percent: 30 });
        await uploadContent(diskPath, innerPath, content, ({ phase, loaded, total }) => {
          if (phase === 'writing' || !(total > 0)) {
            updateUploadItem(diskPath, i, { phase: 'writing', percent: null });
          } else {
            updateUploadItem(diskPath, i, { phase: 'sending', percent: 30 + (loaded / total) * 40 });
          }
        });
        successCount++;
        existingPaths.add(innerPath);
        updateUploadItem(diskPath, i, { status: 'done', percent: 100 });
      } catch (e) {
        errors.push(targetName + ': ' + e.message);
        updateUploadItem(diskPath, i, { status: 'error', error: e.message });
      }
      updateUploadSummary(diskPath);
    }

    // Expand the target folder and refresh
    session.currentDir = dir;
    if (dir !== '/') {
      session.expandedDirs.add(dir);
      expandDirParents(diskPath, dir);
    }
    await loadTree(diskPath);

    if (errors.length === 0) {
      // When every file was cancelled at the conflict prompt, do not report "0 files uploaded"
      App.setStatus(successCount > 0
        ? I18N.t('disk.uploaded', { n: successCount })
        : I18N.t('disk.upload-skipped'));
    } else {
      App.setStatus(I18N.t('disk.upload-summary', { ok: successCount, fail: errors.length }));
      alert(I18N.t('disk.upload-failed') + '\n' + errors.join('\n'));
    }
  }

  // Use XHR so the real upload byte progress is available
  // onProgress receives { phase, loaded, total }: phase = 'sending' while transferring |
  // 'writing' once the body is sent and the server is writing (shown as indeterminate)
  function uploadContent(diskPath, innerPath, content, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/disks/${diskApiPath(diskPath)}/write?path=${encodeURIComponent(innerPath)}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress({ phase: 'sending', loaded: e.loaded, total: e.total });
        };
        // Body fully sent -> enter the server write phase
        xhr.upload.onload = () => onProgress({ phase: 'writing', loaded: 0, total: 0 });
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

  // Read a local file as text; onProgress reports real read-byte progress
  function readFileAsText(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      if (typeof onProgress === 'function') {
        reader.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }
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

  // ---------- Mirror mode ----------

  async function loadMirrorStatus(diskPath, vm) {
    try {
      const status = await App.api(`disks/${diskApiPath(diskPath)}/mirror`);
      const session = getSession(diskPath);
      session.mirror = status;
      renderMirrorStatus(diskPath);
    } catch (e) {
      // Non-VM disks (e.g. templates) do not support mirroring; ignore the error
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
    const enabled = (session.mirror && session.mirror.enabled) || false;
    const currentPath = (session.mirror && session.mirror.path) || '';

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
