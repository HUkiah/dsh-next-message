/**
 * 下一条消息预测 —— 浏览器半（手写 module wrapper，无构建步骤）。
 *
 * 轮询 host 取建议，渲染在 composer 卡片内（对齐内置 placeholder），Tab 接受后写入草稿。
 * 采纳不是永久忽略：草稿被删空后建议会重新出现。
 * 失败时在输入框上方显示一行诊断，正常路径界面里没有任何插件痕迹。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-next-message',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PKG = '@local/dsh-next-message';
    const NS = 'nextMessage';
    const POLL_MS = 700;

    // ── 自检状态 ──────────────────────────────────────────────────────
    // 成功收到过建议后诊断行自动消失，界面恢复干净；在那之前一直显示，
    // 便于在没有浏览器控制台时判断卡在哪一步。
    const FAILURE_STAGES = /^(mount-failed|poll-error|poll-rejected|ghost-no-read|apply-threw)/;
    const status = {
      stage: 'boot',
      detail: '',
      error: false,
      pollCount: 0,
      seenCount: 0,
      everSucceeded: false,
      lastSuggestion: null,
      ghostVisible: false,
    };
    const listeners = new Set();
    function setStatus(stage, detail) {
      status.stage = stage;
      status.detail = detail ?? '';
      status.error = FAILURE_STAGES.test(stage);
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // 订阅者异常不影响状态更新。
        }
      }
    }

    const jsonCodec = (typeSymbol) => ({
      mode: 'strict',
      typeSymbol,
      create: () => ({ parse: (value) => value }),
    });

    const TYPERT_REMOTE = {
      package: PKG,
      descriptors: [
        {
          id: `${PKG}#${NS}/suggestion`,
          service: NS,
          namespace: NS,
          method: 'suggestion',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: jsonCodec('string') },
          ],
          result: { mode: 'strict', typeSymbol: `${PKG}#Suggestion`, create: () => ({ parse: (v) => v }) },
        },
        {
          id: `${PKG}#${NS}/release`,
          service: NS,
          namespace: NS,
          method: 'release',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: jsonCodec('string') },
          ],
          result: { mode: 'strict', typeSymbol: `${PKG}#Ack`, create: () => ({ parse: (v) => v }) },
        },
        {
          id: `${PKG}#${NS}/accepted`,
          service: NS,
          namespace: NS,
          method: 'accepted',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: jsonCodec('string') },
            { name: 'turn', wire: 'turn', source: 'json', codec: jsonCodec('number') },
            { name: 'text', wire: 'text', source: 'json', codec: jsonCodec('string') },
          ],
          result: { mode: 'strict', typeSymbol: `${PKG}#Ack`, create: () => ({ parse: (v) => v }) },
        },
      ],
    };

    /** 当前仍挂载着本插件的会话。用于区分「真的离开」和 HMR / 严格模式的重挂载。 */
    const activeSessions = new Set();

    const css = {
      host: 'dsh-next-message-host',
      text: 'dsh-next-message-text',
      key: 'dsh-next-message-key',
      status: 'dsh-next-message-status',
    };

    const STYLE_ID = `${PKG}/next-message.css`;
    function injectStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = PKG;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = [
        // 灰字要能把整条建议显示完，所以不省略、允许换行（overflow-wrap 兜住长路径/长
        // token）。换行带来的高度由 Ghost 组件显式抬高编辑器最小高度来腾地方——host 是
        // 绝对定位，撑不高卡片，光换行会盖住下面的工具栏。
        `.${css.host}{position:absolute;z-index:5;display:flex;align-items:baseline;gap:6px;`,
        'pointer-events:none;user-select:none;white-space:pre-wrap;overflow-wrap:anywhere;',
        'color:var(--dsw-alias-label-caption);max-width:calc(100% - 28px)}',
        `.${css.text}{white-space:pre-wrap;overflow-wrap:anywhere}`,
        `.${css.key}{flex:none;font-size:.75em;line-height:1.4;padding:0 5px;border-radius:4px;`,
        'border:1px solid currentColor;opacity:.6}',
        `.${css.status}{font-size:11px;line-height:1.6;opacity:.85;color:var(--dsw-alias-label-caption);`,
        'word-break:break-all;padding:2px 6px;border:1px dashed currentColor;border-radius:4px}',
        '[data-composer-card][data-next-message] [data-composer-placeholder]{visibility:hidden}',
      ].join('');
      document.head.appendChild(tag);
    }

    /** 用内置 placeholder 的实测位置对齐灰字，避免写死像素值。 */
    function alignToPlaceholder(host, card) {
      const editor = card.querySelector('[contenteditable]');
      const cardBox = card.getBoundingClientRect();
      if (editor !== null) {
        const style = window.getComputedStyle(editor);
        host.style.font = style.font;
        host.style.lineHeight = style.lineHeight;
        host.style.letterSpacing = style.letterSpacing;
      }
      const placeholder = card.querySelector('[data-composer-placeholder]');
      const anchor = placeholder ?? editor;
      if (anchor === null) {
        host.style.inset = '4px auto auto 14px';
        return;
      }
      const box = anchor.getBoundingClientRect();
      host.style.inset = `${String(Math.round(box.top - cardBox.top))}px auto auto ${String(
        Math.round(box.left - cardBox.left),
      )}px`;
    }


    /** 接受建议的按键。Enter 必须在 capture 阶段拦掉，否则会触发发送。 */
    const ACCEPT_KEYS = new Set(['Tab', 'ArrowRight', 'Enter']);

    /** 标准座位可能还没就绪，缺失时给兜底值，绝不让渲染抛异常。 */
    function seat(hook, selector, fallback) {
      return typeof hook === 'function' ? hook(selector) : fallback;
    }

    function describeError(error) {
      if (error === null || error === undefined) return 'unknown';
      if (typeof error === 'string') return error;
      return String(error.message ?? JSON.stringify(error));
    }

    function Ghost(props) {
      const { sessionId, useInput, inputActions, accept: acceptRemote, release, read } = props;
      const draft = seat(useInput, (state) => state?.draft ?? '', '');
      const phase = seat(useInput, (state) => state?.phase ?? 'plain', 'plain');
      const queueLength = seat(useInput, (state) => state?.queue?.length ?? 0, 0);
      const [suggestion, setSuggestion] = React.useState(null);
      const hostRef = React.useRef(null);
      const seenTurnRef = React.useRef(-1);

      // 输入法组合期间一律不显示：预编辑文本还没落进草稿，此时给建议是干扰。
      // 必须在 visible 之前声明。
      const [composing, setComposing] = React.useState(false);
      React.useEffect(() => {
        const onStart = () => setComposing(true);
        const onEnd = () => setComposing(false);
        document.addEventListener('compositionstart', onStart, true);
        document.addEventListener('compositionend', onEnd, true);
        return () => {
          document.removeEventListener('compositionstart', onStart, true);
          document.removeEventListener('compositionend', onEnd, true);
        };
      }, []);

      // 采纳不是永久忽略。草稿被删空后建议要重新出现，这是 Codex 的行为。
      const visible =
        suggestion !== null &&
        suggestion.text !== '' &&
        draft === '' &&
        phase === 'plain' &&
        composing === false;

      const liveRef = React.useRef({ suggestion: null, visible: false, draft: '', queueLength: 0 });
      liveRef.current.suggestion = suggestion;
      liveRef.current.visible = visible;
      liveRef.current.draft = draft;
      liveRef.current.queueLength = queueLength;

      React.useEffect(() => {
        status.ghostVisible = visible;
        setStatus('ghost-' + (visible ? 'visible' : 'hidden'), visible ? suggestion?.text ?? '' : '');
      }, [visible, suggestion]);

      React.useEffect(() => {
        let live = true;
        const tick = () => {
          if (typeof read !== 'function') {
            setStatus('ghost-no-read', 'inject face 缺少 read');
            return;
          }
          status.pollCount += 1;
          Promise.resolve(read())
            .then((result) => {
              if (!live) return;
              if (result !== null && result !== undefined && result.ok === false) {
                setStatus('poll-error', describeError(result.error));
                return;
              }
              const value = result !== null && result !== undefined && result.ok === true ? result.value : null;
              setSuggestion((prev) =>
                prev !== null && value !== null && prev.turn === value.turn && prev.text === value.text
                  ? prev
                  : value,
              );
              if (value === null) {
                status.ghostVisible = false;
                if (!status.everSucceeded) setStatus('poll-empty', `第 ${String(status.pollCount)} 次轮询返回 null`);
                return;
              }
              status.everSucceeded = true;
              if (value.turn !== seenTurnRef.current) {
                seenTurnRef.current = value.turn;
                status.seenCount += 1;
                status.lastSuggestion = value;
              }
              setStatus('poll-got', `#${String(status.seenCount)} ${value.text}`);
            })
            .catch((error) => {
              setStatus('poll-rejected', describeError(error));
            });
        };
        tick();
        const timer = window.setInterval(tick, POLL_MS);
        return () => {
          live = false;
          window.clearInterval(timer);
        };
      }, [read]);

      React.useEffect(() => {
        const host = hostRef.current;
        const card = host === null ? null : host.closest('[data-composer-card]');
        if (host === null || card === null) return undefined;
        const editor = card.querySelector('[contenteditable]');
        // 先复位上一轮抬过的高度，否则 min-height 会一轮轮叠加。
        const reset = () => {
          if (editor !== null) editor.style.removeProperty('min-height');
        };
        if (!visible) {
          card.removeAttribute('data-next-message');
          reset();
          return undefined;
        }
        card.setAttribute('data-next-message', '');
        reset();
        alignToPlaceholder(host, card);
        // 灰字换行之后有多高，就让编辑器长多高——卡片随之长高，工具栏被顶下去而不是被盖住。
        // 和真的在输入框里打这么多字是同一个效果，所以布局不会显得突兀。
        if (editor !== null) {
          const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight);
          const line = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
          const extra = host.getBoundingClientRect().height - line;
          if (extra > 1) {
            editor.style.minHeight = `${String(Math.round(editor.clientHeight + extra))}px`;
            // 长高之后锚点可能位移，重新对齐一次。
            alignToPlaceholder(host, card);
          }
        }
        return () => {
          card.removeAttribute('data-next-message');
          reset();
        };
      }, [visible, suggestion]);

      // 离开这个会话时清掉建议、取消在飞请求。延迟是为了区分真正的离开与重挂载。
      React.useEffect(() => {
        const sid = String(sessionId);
        activeSessions.add(sid);
        return () => {
          activeSessions.delete(sid);
          window.setTimeout(() => {
            if (!activeSessions.has(sid) && typeof release === 'function') release();
          }, 1500);
        };
      }, [sessionId, release]);

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (!ACCEPT_KEYS.has(event.key)) return;
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
          // 输入法组合期间绝不接受：中文输入法的 Enter 是上屏键。
          if (event.isComposing || event.keyCode === 229) return;
          if (!liveRef.current.visible) return;
          // 再次核对草稿：从渲染到按键之间用户可能已经打了字，绝不覆盖。
          if (liveRef.current.draft !== '') return;
          // 保留 DSH 原有的「空草稿加速 Enter 转向排队消息」手势，有排队消息时 Enter 让路。
          if (event.key === 'Enter' && liveRef.current.queueLength > 0) return;
          const target = event.target;
          if (!(target instanceof Element) || target.closest('[data-composer-card]') === null) return;
          if (event.defaultPrevented) return;
          const current = liveRef.current.suggestion;
          if (current === null) return;
          event.preventDefault();
          event.stopPropagation();
          const span = inputActions?.captureInsertion?.();
          const applied = span === undefined ? false : inputActions.insertText(current.text, span) === true;
          if (!applied) inputActions?.setDraft?.(current.text);
          if (typeof acceptRemote === 'function') acceptRemote(current.turn, current.text);
          setStatus('tab-accepted', `${current.text}（insertText=${applied ? 'ok' : 'fallback-setDraft'}）`);
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [acceptRemote, inputActions]);

      if (!visible) return null;
      return h(
        'div',
        { ref: hostRef, className: css.host, role: 'status', 'aria-live': 'polite' },
        h('span', { className: css.text }, suggestion.text),
        h('kbd', { className: css.key }, 'Tab'),
      );
    }

    /** 只在出错时出现的诊断行。正常使用时界面里没有它。 */
    function ErrorRibbon() {
      const [count, force] = React.useState(0);
      React.useEffect(() => {
        const listener = () => force((value) => value + 1);
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, []);
      // 出错时显示；另外启动后约 10 秒仍拿不到建议也显示，用来区分「没轮询」和「轮询但为空」。
      const stalled = !status.everSucceeded && status.pollCount > 15;
      if (!status.error && !stalled) return null;
      const text = [
        `next-message 自检 [${status.stage}]`,
        status.detail ? ` ${status.detail}` : '',
        ` · 轮询 ${String(status.pollCount)} 次`,
        ` · 收到建议 ${String(status.seenCount)} 次`,
        ` · 灰字=${status.ghostVisible ? '显示中' : '未显示'}`,
        ` · 渲染 ${String(count)}`,
      ].join('');
      return h('div', { className: css.status }, text);
    }

    async function apply(ctx) {
      setStatus('apply-entered', '');
      injectStyle();

      // 出错诊断行先挂：后面任何一步失败，它都能把错误显示出来。
      ctx.inject(['slots'], (slotScope) => {
        slotScope.slots.inject('conversation.input.dock', () =>
          slotScope.slots.register(
            { name: 'conversation.input.dock', id: 'next-message-error', order: 0 },
            ErrorRibbon,
          ),
        );
      });

      // 模块级 inject 保持为空：任一服务名写错都会让插件永久 pending 且毫无提示。
      // 依赖一律在这里显式等待，参考 ui-input-trigger 的写法。
      ctx.inject(['remote'], async (remoteScope) => {
        setStatus('remote-ready', '');
        try {
          await remoteScope.remote.$mount(TYPERT_REMOTE);
        } catch (error) {
          setStatus('mount-failed', describeError(error));
          return;
        }

        remoteScope.inject(['slots', 'sessions', 'conversation', 'remote.nextMessage'], (scope) => {
          const api = scope.remote.nextMessage;
          scope.slots.inject('conversation.input.overlay', () =>
            scope.slots.register(
              {
                name: 'conversation.input.overlay',
                id: 'next-message',
                order: 10,
                inject: (sessionId) => ({
                  read: () => api.suggestion(String(sessionId)),
                  release: () => {
                    Promise.resolve(api.release(String(sessionId))).catch(() => {});
                  },
                  accept: (turn, text) => {
                    Promise.resolve(api.accepted(String(sessionId), turn, text)).catch(() => {});
                    const actx = scope.sessions.scope(sessionId);
                    if (actx !== undefined) scope.conversation.input.for(actx).focus();
                  },
                }),
              },
              Ghost,
            ),
          );
          setStatus('slots-registered', '');
        });
      });
    }

    return { apply, inject: [] };
  },
});
