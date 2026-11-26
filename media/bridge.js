/**
 * CyberChef <-> VS Code bridge.
 *
 * Injected into CyberChef's index.html by the extension's local server. It runs inside
 * the CyberChef iframe and talks to the parent webview through window.postMessage.
 * CyberChef itself is left untouched; this only uses its public `window.app` object.
 */
(function () {
    "use strict";

    var TAG = "__cyberchefVscode";
    var embedded = window.parent && window.parent !== window;
    if (!embedded) return; // Opened directly in a browser: behave like stock CyberChef.

    var ready = false;
    var queue = [];

    function post(msg, transfer) {
        msg[TAG] = true;
        window.parent.postMessage(msg, "*", transfer || []);
    }

    function app() {
        return window.app;
    }

    // ------------------------------------------------------------------------------
    // Downloads: VS Code webviews cannot save files themselves, so route CyberChef's
    // "Save output to file" / "Save recipe" downloads to the extension (native dialog).
    // CyberChef uses FileSaver.js, which clicks a detached <a download href=blob:...>.
    // ------------------------------------------------------------------------------
    function interceptDownload(anchor) {
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.hasAttribute("download")) return false;
        var href = anchor.href;
        var name = anchor.getAttribute("download") || "download";
        if (!href) return false;
        fetch(href)
            .then(function (r) {
                return r.arrayBuffer();
            })
            .then(function (buf) {
                post({ type: "saveFile", name: name, data: buf }, [buf]);
            })
            .catch(function (e) {
                post({ type: "error", message: "Could not save file: " + (e && e.message ? e.message : e) });
            });
        return true;
    }

    var origDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (evt) {
        if (evt && evt.type === "click" && interceptDownload(this)) return false;
        return origDispatch.apply(this, arguments);
    };
    var origClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
        if (interceptDownload(this)) return;
        return origClick.apply(this, arguments);
    };

    // Real user clicks on links: downloads go to VS Code, external links open in the browser.
    document.addEventListener(
        "click",
        function (e) {
            var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
            if (!a) return;
            if (interceptDownload(a)) {
                e.preventDefault();
                return;
            }
            var url;
            try {
                url = new URL(a.href, location.href);
            } catch (_) {
                return;
            }
            if (url.origin !== location.origin && /^(https?|mailto):$/.test(url.protocol)) {
                e.preventDefault();
                post({ type: "openExternal", url: url.href });
            }
        },
        true
    );

    // window.open for external URLs (e.g. "Report a bug") -> system browser.
    var origOpen = window.open;
    window.open = function (url) {
        try {
            var u = new URL(url, location.href);
            if (u.origin !== location.origin && /^(https?|mailto):$/.test(u.protocol)) {
                post({ type: "openExternal", url: u.href });
                return null;
            }
        } catch (_) {
            /* fall through */
        }
        return origOpen.apply(window, arguments);
    };

    // ------------------------------------------------------------------------------
    // window.prompt: webviews are sandboxed without allow-modals, so prompt() silently
    // returns null and CyberChef features such as "Save output" or "Go to tab" break.
    // Filename prompts get the suggested name (VS Code's save dialog follows anyway);
    // any other prompt is shown as a VS Code input box via a synchronous request.
    // ------------------------------------------------------------------------------
    var origPrompt = window.prompt;
    window.prompt = function (message, defaultValue) {
        message = message === undefined ? "" : String(message);
        defaultValue = defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);
        if (/^please enter a filename/i.test(message)) return defaultValue || "download";
        var token = window.__cyberchefVscodeToken;
        if (!token) return origPrompt.apply(window, arguments);
        try {
            var xhr = new XMLHttpRequest();
            var qs =
                "token=" + encodeURIComponent(token) +
                "&message=" + encodeURIComponent(message) +
                "&default=" + encodeURIComponent(defaultValue);
            xhr.open("GET", "/__vscode/prompt?" + qs, false); // synchronous, like prompt()
            xhr.send();
            if (xhr.status !== 200) return defaultValue;
            return JSON.parse(xhr.responseText).value;
        } catch (e) {
            return defaultValue;
        }
    };

    // ------------------------------------------------------------------------------
    // Clipboard. VS Code intercepts copy/paste/cut for webviews and replays them on the
    // webview's top document, which never reaches this nested iframe; whether the
    // browser's native path still works varies by OS, menu style and permissions. So
    // the clipboard goes through VS Code's own clipboard API (vscode.env.clipboard).
    // CodeMirror editors (Input/Output) get synthetic clipboard events so CyberChef's
    // own handlers run (large pastes, control-char pictures, line-wise copy, read-only).
    // ------------------------------------------------------------------------------
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
    var clipboardWaiters = {};
    var clipboardSeq = 1;
    var lastFocused = null;
    var lastGesture = 0;

    document.addEventListener("focusin", function (e) { lastFocused = e.target; }, true);
    ["keydown", "mousedown", "pointerdown"].forEach(function (type) {
        document.addEventListener(type, function (e) { if (e.isTrusted) lastGesture = Date.now(); }, true);
    });

    function editorViews() {
        var views = [];
        try {
            var m = app().manager;
            if (m.input.inputEditorView) views.push(m.input.inputEditorView);
            if (m.output.outputEditorView) views.push(m.output.outputEditorView);
        } catch (_) { /* not ready */ }
        return views;
    }
    function viewFor(el) {
        if (!el) return null;
        var views = editorViews();
        for (var i = 0; i < views.length; i++) if (views[i].dom.contains(el)) return views[i];
        return null;
    }
    function isTextField(el) {
        return !!el && (el.tagName === "TEXTAREA" ||
            (el.tagName === "INPUT" && /^(text|search|url|tel|password|email|number|)$/i.test(el.getAttribute("type") || "")));
    }
    function clipboardTarget() {
        var el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) el = lastFocused;
        if (!el || !document.contains(el)) {
            // Nothing focused yet: default to CyberChef's Input editor.
            try { el = app().manager.input.inputEditorView.contentDOM; } catch (_) { el = null; }
        }
        return el;
    }

    function requestClipboardText() {
        return new Promise(function (resolve) {
            var id = clipboardSeq++;
            clipboardWaiters[id] = resolve;
            post({ type: "clipboardRead", requestId: id });
            setTimeout(function () {
                if (clipboardWaiters[id]) { delete clipboardWaiters[id]; resolve(null); }
            }, 5000);
        });
    }
    function writeClipboardText(text) {
        post({ type: "clipboardWrite", text: String(text) });
    }

    /** Returns the selected text in el (performing a cut if asked), or "" if none. */
    function takeSelection(el, cut) {
        var view = viewFor(el);
        if (view) {
            var dt = new DataTransfer();
            view.contentDOM.dispatchEvent(new ClipboardEvent(cut ? "cut" : "copy", { clipboardData: dt, bubbles: true, cancelable: true }));
            return dt.getData("text/plain");
        }
        if (isTextField(el)) {
            var start = null, end = null;
            try { start = el.selectionStart; end = el.selectionEnd; } catch (_) { /* e.g. number inputs */ }
            if (start === null || start === end) return String(window.getSelection() || "");
            var text = el.value.slice(start, end);
            if (cut && !el.readOnly && !el.disabled) {
                el.focus();
                if (!document.execCommand("delete")) {
                    el.setRangeText("", start, end, "end");
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                }
            }
            return text;
        }
        return String(window.getSelection() || "");
    }

    function insertText(el, text) {
        if (!text) return;
        var view = viewFor(el);
        if (view) {
            var dt = new DataTransfer();
            dt.setData("text/plain", text);
            view.focus();
            view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
            return;
        }
        if (isTextField(el) || (el && el.isContentEditable)) {
            if (el.readOnly || el.disabled) return;
            el.focus();
            if (!document.execCommand("insertText", false, text) && isTextField(el)) {
                var s = el.selectionStart, e = el.selectionEnd;
                el.setRangeText(text, s === null ? el.value.length : s, e === null ? el.value.length : e, "end");
                el.dispatchEvent(new Event("input", { bubbles: true }));
            }
        }
    }

    document.addEventListener("keydown", function (e) {
        var mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        if (!mod || e.altKey) return;
        var key = (e.key || "").toLowerCase();
        var el = clipboardTarget();

        if (key === "v") {
            e.preventDefault();
            e.stopImmediatePropagation();
            requestClipboardText().then(function (text) { insertText(el, text); });
        } else if ((key === "c" || key === "x") && !e.shiftKey) {
            var text = takeSelection(el, key === "x");
            if (!text) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            writeClipboardText(text);
        } else if (isTextField(el) && !viewFor(el)) {
            // Plain inputs (search box, recipe arguments): make select-all / undo / redo
            // independent of VS Code's Edit menu too. CodeMirror handles its own.
            if (key === "a" && !e.shiftKey) { e.preventDefault(); el.select(); }
            else if (key === "z" && !e.shiftKey) { e.preventDefault(); document.execCommand("undo"); }
            else if ((key === "z" && e.shiftKey) || (key === "y" && !isMac)) { e.preventDefault(); document.execCommand("redo"); }
        }
    }, true);

    // CyberChef's "Copy raw output to clipboard" button uses navigator.clipboard, which may
    // be denied inside nested webview frames. Route it through VS Code as well. Reading is
    // only allowed right after a real user key press or click, like a browser would require.
    try {
        var clip = {
            writeText: function (t) { writeClipboardText(t); return Promise.resolve(); },
            readText: function () {
                if (Date.now() - lastGesture > 1500) {
                    return Promise.reject(new DOMException("Clipboard read requires a user gesture.", "NotAllowedError"));
                }
                return requestClipboardText().then(function (t) { return t === null ? "" : t; });
            },
        };
        if (navigator.clipboard) {
            navigator.clipboard.writeText = clip.writeText;
            navigator.clipboard.readText = clip.readText;
        } else {
            Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
        }
    } catch (_) { /* keep the browser's implementation */ }

    // ------------------------------------------------------------------------------
    // Commands from VS Code
    // ------------------------------------------------------------------------------
    function applyTheme(theme) {
        if (!theme || theme === "cyberchef") return;
        try {
            app().manager.options.changeTheme(theme);
        } catch (e) {
            document.documentElement.className = theme;
        }
    }

    function getOutput() {
        var a = app();
        var tab = a.manager.tabs.getActiveTab("output");
        var dish = a.manager.output.getOutputDish(tab);
        if (!dish) return Promise.reject(new Error("No output yet. Add operations to the recipe and bake."));
        return a.manager.output.getDishStr(dish);
    }

    function handle(msg) {
        var a = app();
        switch (msg.type) {
            case "setInput":
                a.setInput(String(msg.value));
                break;
            case "loadFile": {
                var file = new File([msg.data], msg.name || "file", { type: msg.mime || "" });
                a.manager.input.loadUIFiles([file]);
                break;
            }
            case "setRecipe": {
                var params = { recipe: String(msg.recipe) };
                if (msg.theme && msg.theme !== "cyberchef") params.theme = msg.theme;
                a.loadURIParams(params);
                break;
            }
            case "setTheme":
                applyTheme(msg.theme);
                break;
            case "bake":
                a.manager.controls.bakeClick();
                break;
            case "clipboardText": {
                var waiter = clipboardWaiters[msg.requestId];
                if (waiter) {
                    delete clipboardWaiters[msg.requestId];
                    waiter(typeof msg.text === "string" ? msg.text : null);
                }
                break;
            }
            case "pasteText": // Edit > Paste / Command Palette, relayed by the panel
                insertText(clipboardTarget(), String(msg.text || ""));
                break;
            case "copyRequest": { // Edit > Copy / Cut, relayed by the panel
                var copied = takeSelection(clipboardTarget(), !!msg.cut);
                if (copied) writeClipboardText(copied);
                break;
            }
            case "getOutput":
                getOutput().then(
                    function (value) {
                        post({ type: "output", requestId: msg.requestId, value: value });
                    },
                    function (e) {
                        post({ type: "output", requestId: msg.requestId, error: e && e.message ? e.message : String(e) });
                    }
                );
                break;
        }
    }

    window.addEventListener("message", function (e) {
        if (e.source !== window.parent || !e.data || e.data[TAG] !== true) return;
        if (!ready) {
            queue.push(e.data);
            return;
        }
        try {
            handle(e.data);
        } catch (err) {
            if (e.data.type === "getOutput") {
                post({ type: "output", requestId: e.data.requestId, error: String(err && err.message ? err.message : err) });
            } else {
                post({ type: "error", message: String(err && err.message ? err.message : err) });
            }
        }
    });

    function onReady() {
        if (ready) return;
        ready = true;
        var pending = queue;
        queue = [];
        pending.forEach(function (m) {
            try {
                handle(m);
            } catch (err) {
                post({ type: "error", message: String(err && err.message ? err.message : err) });
            }
        });
        post({ type: "ready" });
    }

    // CyberChef mirrors the recipe (and small inputs) into location.hash on every change.
    // Report it so the panel can restore the same state after a VS Code window reload.
    var stateTimer = null;
    window.addEventListener("statechange", function () {
        clearTimeout(stateTimer);
        stateTimer = setTimeout(function () {
            post({ type: "state", hash: location.hash });
        }, 250);
    });

    // CyberChef fires "apploaded" on document when the UI and workers are ready.
    document.addEventListener("apploaded", function () {
        // loaded() also runs loadURIParams and theme logic; let it finish first.
        setTimeout(onReady, 0);
    });

    post({ type: "loading" });
})();
