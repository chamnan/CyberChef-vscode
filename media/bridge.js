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
