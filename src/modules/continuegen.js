/* ============================================================
 * modules/continuegen：搜索块场景的“继续生成”入口
 *
 * 按钮只追加到当前候选消息行。所有更新均幂等；点击时重新查询该行当前
 * 的“重新生成”按钮，避免 React 重渲染后持有失效节点。
 * ============================================================ */
var ContinueGenerate = {
  LABEL: '继续生成',
  CLASS: 'dcp-continue-generate',
  _timer: 0,
  _scanning: false,
  _again: false,
  _observer: null,
  _buttons: new Set(),

  textOf: function (m) {
    return (m && m.blocks || []).filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text || ''; }).join('').trim();
  },

  shouldOffer: function (m) {
    if (!m || m.role !== 'assistant' || !this.textOf(m)) return false;
    var search = DCP.modules && DCP.modules.demoSearch;
    return !!(search && search.hasToolBlocks && search.hasToolBlocks(m) && search.isRecoverableStatus(m));
  },

  officialButton: function (root) {
    if (!root) return null;
    return UI.findByLabels(root, ['继续生成', 'Continue', 'Continue generating'], 'button', true);
  },

  regenerateButton: function (bar) {
    if (!bar) return null;
    return UI.findByLabels(bar, ['重新生成', 'Regenerate', 'Regenerate response'], 'button', true);
  },

  template: function () {
    return DCP.qs('continueButton');
  },

  updateButton: function (btn) {
    if (!btn) return;
    var label = DCP.t(this.LABEL);
    UI.setTextIfChanged(btn, label);
    UI.setAttributeIfChanged(btn, 'aria-label', label);
    if (btn.title !== label) btn.title = label;
    UI.markOwned(btn);
  },

  makeButton: function (row) {
    var self = this;
    var official = this.template();
    var btn = official ? official.cloneNode(true) : document.createElement('button');
    btn.type = 'button';
    btn.id = '';
    btn.className = (official ? official.className : '') + ' ' + this.CLASS;
    btn.removeAttribute('aria-disabled');
    btn.disabled = false;
    if (!official) {
      btn.style.cssText = 'box-sizing:border-box;height:32px;padding:0 16px;border:1px solid var(--dcp-border,rgba(127,127,127,.28));' +
        'border-radius:16px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;flex:0 0 auto';
    }
    this.updateButton(btn);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!row || !row.isConnected) return;
      var bar = DCP.qs('aiActionBar', row);
      var regen = self.regenerateButton(bar);
      if (!regen || regen.disabled) return;
      Utils.realClick(regen);
    }, true);
    return btn;
  },

  removeOwn: function (root) {
    if (!root) return false;
    var old = root.querySelector('.' + this.CLASS);
    if (!old) return false;
    old.remove();
    this._buttons.delete(old);
    return true;
  },

  ensure: function (candidate) {
    candidate = candidate || {};
    var row = candidate.row;
    if (!row || !row.isConnected) return false;
    var bar = DCP.qs('aiActionBar', row);
    var bottom = bar && bar.parentElement;
    if (!bottom) return this.removeOwn(row);

    var official = this.officialButton(bottom);
    var regen = this.regenerateButton(bar);
    var eligible = !!(candidate.message && this.shouldOffer(candidate.message));
    var wanted = !!(eligible && !official && regen && !regen.disabled);
    var existing = bottom.querySelector('.' + this.CLASS);
    if (!wanted) {
      if (existing) {
        existing.remove();
        this._buttons.delete(existing);
        return true;
      }
      return false;
    }
    if (existing) {
      this.updateButton(existing);
      this._buttons.add(existing);
      return false;
    }
    var btn = this.makeButton(row);
    bottom.appendChild(btn);
    this._buttons.add(btn);
    return true;
  },

  removeAll: function () {
    var removed = false;
    this._buttons.forEach(function (btn) {
      if (btn && btn.isConnected) {
        btn.remove();
        removed = true;
      }
    });
    this._buttons.clear();
    return removed;
  },

  scan: async function () {
    if (this._scanning) { this._again = true; return; }
    var epoch = UI.sessionEpoch();
    this._scanning = true;
    try {
      var search = DCP.modules && DCP.modules.demoSearch;
      if (!search || typeof search.currentSession !== 'function') return;
      var session = await search.currentSession();
      if (epoch !== UI.sessionEpoch()) {
        this.removeAll();
        return;
      }
      if (!session) {
        this.removeAll();
        return;
      }
      var chain = search.chain(session);
      var last = chain[chain.length - 1];
      var rows = DCP.qsa('msgRowAi');
      var row = rows.length ? rows[rows.length - 1] : null;
      if (!this.shouldOffer(last) || !row) {
        this.removeAll();
        return;
      }
      this.ensure({ session: session, message: last, row: row });
      this._buttons.forEach(function (btn) {
        if (!btn.isConnected) ContinueGenerate._buttons.delete(btn);
      });
    } catch (e) {
    } finally {
      this._scanning = false;
      if (this._again) {
        this._again = false;
        this.schedule();
      }
    }
  },

  schedule: function () {
    if (this._timer) return;
    this._timer = setTimeout(function () {
      this._timer = 0;
      this.scan();
    }.bind(this), 160);
  },

  init: function () {
    if (this._inited) return;
    this._inited = true;
    var self = this;
    Utils.onReady(function () {
      self.scan();
      self._observer = UI.observeRelevant(document.body, function () { self.schedule(); }, {
        childList: true,
        subtree: true,
        characterData: true
      });
      DCP.on('session:activity', function () { self.schedule(); });
      DCP.on('session:change', function () { self.schedule(); });
      DCP.on('session:leave', function () { self.schedule(); });
    });
  },

  destroy: function () {
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0;
    if (this._observer) this._observer.disconnect();
    this._observer = null;
    this.removeAll();
  }
};
DCP.modules.continueGen = ContinueGenerate;
