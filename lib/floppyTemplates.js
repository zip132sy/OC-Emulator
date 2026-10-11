// lib/floppyTemplates.js
// Floppy disk templates for the OC Emulator.
// All templates use official OpenComputers source code from the loot directory.
// Run scripts/downloadFloppies.js to download/refresh floppy files.

const fs = require('fs');
const path = require('path');

const OPENOS_CACHE = path.join(__dirname, '..', 'cache', 'openos-download');
const FLOPPY_CACHE = path.join(__dirname, '..', 'cache', 'floppy-download');

function loadFilesFromDir(baseDir, prefix = '') {
  const files = {};
  if (!fs.existsSync(baseDir)) return files;
  const walk = (absPath, relPath) => {
    const items = fs.readdirSync(absPath);
    for (const item of items) {
      const itemAbs = path.join(absPath, item);
      const itemRel = (relPath === '/' ? '' : relPath) + '/' + item;
      const stat = fs.statSync(itemAbs);
      if (stat.isDirectory()) {
        walk(itemAbs, itemRel);
      } else {
        files[itemRel] = fs.readFileSync(itemAbs, 'utf8');
      }
    }
  };
  walk(baseDir, prefix);
  return files;
}

function loadTemplate(name, opts = {}) {
  const dir = path.join(FLOPPY_CACHE, name);
  const files = loadFilesFromDir(dir);
  const template = {
    label: opts.label || name,
    files: files,
  };
  if (opts.locked) template.locked = true;
  if (opts.disabled) {
    template.disabled = true;
    template.disabledReason = opts.disabledReason || 'Requires robot component';
  }
  if (opts.fromDir) {
    template.fromDir = opts.fromDir;
  }
  return template;
}

const templates = {
  OpenOS: {
    label: 'OpenOS',
    locked: true,
    files: loadFilesFromDir(OPENOS_CACHE),
  },
  OpenLoader: loadTemplate('OpenLoader', { label: 'OpenLoader' }),
  Plan9k: loadTemplate('Plan9k', { label: 'Plan9k' }),
  Network: loadTemplate('Network', { label: 'Network', fromDir: '/data/' }),
  OPPM: loadTemplate('OPPM', { label: 'OPPM' }),
  OpenIRC: loadTemplate('OpenIRC', { label: 'OpenIRC' }),
  Data: loadTemplate('Data', { label: 'Data Card Software' }),
  Builder: loadTemplate('Builder', {
    label: 'Builder',
    disabled: true,
    disabledReason: 'Requires robot component',
  }),
  Dig: loadTemplate('Dig', {
    label: 'Digger',
    disabled: true,
    disabledReason: 'Requires robot component',
  }),
  Maze: loadTemplate('Maze', {
    label: 'Mazer',
    disabled: true,
    disabledReason: 'Requires robot component',
  }),
  Generator: loadTemplate('Generator', {
    label: 'Generator Upgrade Software',
    disabled: true,
    disabledReason: 'Requires generator upgrade (robot)',
  }),
};

module.exports = templates;
