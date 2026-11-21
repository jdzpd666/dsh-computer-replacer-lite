/**
 * dsh-computer-replacer — 客户端半边（§7.5 急停按钮 Panic Button UI）。
 *
 * 交付形态：单文件 bundle，DSH client ModuleLoader 包裹格式
 * （与 dsh-better-sidebar / dsh-codex-effort-slider 的 lib/client.js 同构）：
 *   window.__ModuleLoader__.load({ id, factory: function (require) {...} })
 * react / react-dom 由 shell 的模块加载器在运行时通过 factory 的 require 提供
 * （dsh-codex-effort-slider 同机制实证），因此本插件无需自带 react 依赖。
 *
 * 挂载：官方 slot API，主锚 conversation.input.left（kind:'list'，
 * scope:'session'，输入栏工具行左区，权限预设组与模型选择器之间）。
 * 降级序（计划 §9 拍板③）：
 *   1) slot 主锚（react 组件）；
 *   2) 锚点 8 秒内未就位 / slots 服务缺失 → 纯 DOM 悬浮徽标（零框架，视觉一致）；
 *   3) 徽标也失败 → 静默放弃（红线：绝不破坏聊天输入栏）。
 *
 * 客户端 ⇄ 宿主：同源 fetch POST /computer-replacer/api/{panic.trip,panic.recover,panic.status}
 * （Electron shell 的 dsh-app://app protocol.handle 把非静态路径转发到 Host；
 * URL 相对 document.baseURI 目录解析，防反代前缀剥离 —— host-route-url 教训）。
 *
 * 三态：急停（红，未闩锁）→ 已急停（闩锁，点击进入确认态）→ 确认恢复（二次确认防误触，
 * 5 秒不点回退）。轮询 panic.status 同步热键路径（worker exit 87 → TS 闩锁 → 按钮自动变"已急停"）。
 *
 * 修正案二边界（title/PLUGIN.md/报告三处）：急停只切断 computer-replacer 的注入通道，
 * 不停止模型通过 DSH 自带工具（bash/PowerShell 等）的行动；已发出的消息无法撤回。
 */
window.__ModuleLoader__.load({
  id: 'dsh-computer-replacer',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    var SLOT_NAME = 'conversation.input.left';
    var ENTRY_ID = 'computer-replacer-panic-button';
    var ENTRY_ORDER = 60;
    var API_PREFIX = 'computer-replacer/api/';
    var POLL_MS = 1500;
    /** 主锚就位探测窗口：超时未就位 → 悬浮徽标降级（11.1 风险 2）。 */
    var ANCHOR_WAIT_MS = 8000;
    /** 确认恢复态回退窗口。 */
    var CONFIRM_TIMEOUT_MS = 5000;

    var TEXT = {
      trip: '急停',
      latched: '已急停',
      confirm: '确认恢复?',
      title: '急停：立即切断本插件的全部注入通道（不停止模型使用 DSH 自带工具，如 bash/PowerShell）。已发出的消息无法撤回。恢复需二次确认。',
      badge: '急停（悬浮）',
    };

    // ── 同源 fetch（目录相对解析，照抄 host-route-url 的教训）─────────────
    function apiBase() {
      var base = String((typeof document !== 'undefined' && document.baseURI) || window.location.href);
      base = base.split('#')[0].split('?')[0];
      if (base.charAt(base.length - 1) !== '/') base = base.slice(0, base.lastIndexOf('/') + 1);
      return base;
    }
    function apiUrl(method) {
      return new URL(API_PREFIX + method, apiBase()).href;
    }
    function callApi(method) {
      return fetch(apiUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; });
      }).then(function (data) {
        if (data && data.ok) return data;
        throw new Error((data && data.error && data.error.message) || 'panic API failed');
      });
    }

    // ── 修正案二 + 诚实边界提示（title / aria-label 共用）────────────────
    function tooltip() { return TEXT.title; }

    // ── React 组件（slot 主锚）──────────────────────────────────────────
    function PanicButton() {
      var statePair = React.useState({ latched: false, confirm: false, source: undefined });
      var latched = statePair[0].latched;
      var confirm = statePair[0].confirm;
      var setState = statePair[1];
      React.useEffect(function () {
        var alive = true;
        var timer = undefined;
        var tick = function () {
          callApi('panic.status').then(function (data) {
            if (!alive) return;
            setState(function (prev) {
              var next = { latched: data.latched === true, confirm: false, source: data.source };
              // 用户正在确认态而轮询说未闩锁（竞态）：回退展示态。
              if (prev.confirm && !next.latched) return next;
              if (prev.confirm && next.latched) next.confirm = true;
              return next;
            });
          }).catch(function () { /* 路由暂不可达：保持现状，下轮重试 */ });
        };
        tick();
        timer = setInterval(tick, POLL_MS);
        return function () { alive = false; clearInterval(timer); };
      }, []);
      var onClick = function () {
        if (!latched) {
          setState({ latched: true, confirm: false, source: 'button' }); // 乐观置位
          callApi('panic.trip').catch(function () { });
          return;
        }
        if (!confirm) {
          setState({ latched: true, confirm: true, source: undefined });
          setTimeout(function () {
            setState(function (prev) {
              return prev.confirm ? { latched: prev.latched, confirm: false, source: prev.source } : prev;
            });
          }, CONFIRM_TIMEOUT_MS);
          return;
        }
        setState({ latched: false, confirm: false, source: undefined });
        callApi('panic.recover').catch(function () { });
      };
      var label = !latched ? TEXT.trip : (confirm ? TEXT.confirm : TEXT.latched);
      var background = !latched ? '#c62828' : (confirm ? '#ef6c00' : '#424242');
      return React.createElement('button', {
        type: 'button',
        onClick: onClick,
        title: tooltip(),
        'aria-label': 'computer-replacer 急停按钮',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          margin: '0 4px', padding: '2px 10px', height: '26px',
          fontSize: '12px', fontWeight: 600, lineHeight: '1',
          color: '#fff', background: background,
          border: '1px solid rgba(0,0,0,0.25)', borderRadius: '13px',
          cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
        },
      }, label);
    }

    // ── 纯 DOM 悬浮徽标（降级档：slot 未就位 / slots 服务缺失）──────────
    function mountBadge() {
      if (document.getElementById('dsh-computer-replacer-panic-badge')) return;
      var el = document.createElement('div');
      el.id = 'dsh-computer-replacer-panic-badge';
      el.title = tooltip();
      el.setAttribute('aria-label', 'computer-replacer 急停悬浮徽标');
      var style = el.style;
      style.position = 'fixed'; style.left = '10px'; style.bottom = '46px'; style.zIndex = '2147483000';
      style.padding = '4px 12px'; style.fontSize = '12px'; style.fontWeight = '600';
      style.color = '#fff'; style.background = '#c62828'; style.borderRadius = '14px';
      style.boxShadow = '0 2px 8px rgba(0,0,0,0.35)'; style.cursor = 'pointer'; style.userSelect = 'none';
      el.textContent = TEXT.trip + '·' + TEXT.badge;
      var latched = false;
      var confirm = false;
      var confirmTimer = undefined;
      var paint = function () {
        el.textContent = !latched ? TEXT.trip : (confirm ? TEXT.confirm : TEXT.latched);
        el.style.background = !latched ? '#c62828' : (confirm ? '#ef6c00' : '#424242');
      };
      var poll = function () {
        callApi('panic.status').then(function (data) {
          if (latched === (data.latched === true)) return;
          latched = data.latched === true; confirm = false; paint();
        }).catch(function () { });
      };
      el.addEventListener('click', function () {
        if (!latched) {
          latched = true; confirm = false; paint();
          callApi('panic.trip').catch(function () { });
          return;
        }
        if (!confirm) {
          confirm = true; paint();
          confirmTimer = setTimeout(function () { confirm = false; paint(); }, CONFIRM_TIMEOUT_MS);
          return;
        }
        clearTimeout(confirmTimer);
        latched = false; confirm = false; paint();
        callApi('panic.recover').catch(function () { });
      });
      document.body.appendChild(el);
      paint();
      var timer = setInterval(poll, POLL_MS);
      // 徽标自卸载：slot 主锚后来就位时移除降级档（保持单实例）。
      var anchorWatch = setInterval(function () {
        if (document.querySelector('[data-computer-replacer-panic-slot]')) {
          clearInterval(timer); clearInterval(anchorWatch); el.remove();
        }
      }, POLL_MS);
      return function () { clearInterval(timer); clearInterval(anchorWatch); el.remove(); };
    }

    /**
     * Client plugin body（cordis 风格，与 better-sidebar client 入口同签名）。
     * @param ctx - client cordis context（slots）。
     */
    function apply(ctx) {
      var anchored = false;
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          throw new Error('slots service unavailable');
        }
        ctx.slots.inject(SLOT_NAME, function () {
          anchored = true;
          var unmountBadge = undefined;
          try { unmountBadge = function () { var b = document.getElementById('dsh-computer-replacer-panic-badge'); if (b) b.remove(); }; } catch (_) { }
          if (unmountBadge) unmountBadge();
          var disposer = ctx.slots.register({
            name: SLOT_NAME,
            id: ENTRY_ID,
            order: ENTRY_ORDER,
            label: function () { return TEXT.trip; },
          }, function PanicButtonSlot() {
            return React.createElement('span', { 'data-computer-replacer-panic-slot': '1' }, React.createElement(PanicButton));
          });
          return disposer;
        });
      } catch (error) {
        // 降级 1→2：slots 服务缺失 → 悬浮徽标；徽标也失败 → 静默放弃（红线）。
        try { mountBadge(); } catch (_) { }
        return;
      }
      // 降级 1→2（异步）：主锚一直未就位（DSH 结构变化）→ 悬浮徽标自动启用。
      setTimeout(function () {
        if (anchored) return;
        try { mountBadge(); } catch (_) { }
      }, ANCHOR_WAIT_MS);
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
