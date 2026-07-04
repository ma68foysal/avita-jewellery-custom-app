
/* Avita Diamond Selector — storefront cascade + add-to-cart.
   The browser only ever sends the SELECTION. Every price is computed by the
   app server from Supabase and returned; nothing here is authoritative. */
(function () {
  var COLOUR_RANK = { D: 0, E: 1, F: 2, G: 3, H: 4, I: 5, J: 6 };
  var CLARITY_RANK = { FL: 0, IF: 1, VVS1: 2, VVS2: 3, VS1: 4, VS2: 5, SI1: 6, SI2: 7 };

  function rank(map, v) { return v in map ? map[v] : 999; }
  function uniq(arr) { return Array.prototype.filter.call(arr, function (v, i) { return arr.indexOf(v) === i; }); }

  function initRoot(root) {
    var productGid = root.getAttribute("data-product-gid");
    var proxyBase = root.getAttribute("data-proxy-base");
    var shape = root.getAttribute("data-shape") || "emerald";
    var thumbSource = root.getAttribute("data-thumb-source") || "carat"; // "carat" | "product"
    var cartType = root.getAttribute("data-cart-type") || "drawer"; // theme native: drawer | page | notification

    // Global show/hide from the "Diamond Selector" app embed (theme settings).
    var globalCfg = window.AvitaDiamondSelector;
    if (globalCfg && globalCfg.show === false) { root.style.display = "none"; return; }

    var q = function (sel) { return root.querySelector(sel); };
    var state = { origin: null, carat: null, colour: null, clarity: null, size: null };
    var combos = { natural: [], lab: [] }; // filled from server
    var serverImages = {}; // carat -> url, from options (app mapping + CSV)
    var featuredImage = root.getAttribute("data-featured-image") || "";
    var media = []; // product images with alt text, for the alt-text fallback
    try {
      var mEl = root.querySelector("[data-ds-media]");
      if (mEl) media = JSON.parse(mEl.textContent || "[]");
    } catch (e) { media = []; }

    var el = {
      origin: q("[data-ds-origin]"),
      carat: q("[data-ds-carat]"),
      colour: q("[data-ds-colour]"),
      clarity: q("[data-ds-clarity]"),
      size: q("[data-ds-size]"),
      hintOrigin: q("[data-ds-hint-origin]"),
      base: q("[data-ds-base]"),
      stone: q("[data-ds-stone]"),
      total: q("[data-ds-total]"),
      facet: q("[data-ds-facet]"),
      props: q("[data-ds-props]"),
      cta: q("[data-ds-cta]"),
      msg: q("[data-ds-msg]"),
      image: q("[data-ds-image]"),
      fallback: q("[data-ds-fallback]"),
      thumbs: q("[data-ds-thumbs]"),
    };

    // ---- image resolution: app mapping > CSV > alt-text > featured ------
    function caratNum(v) {
      var n = parseFloat(String(v).replace(/[^\d.]/g, ""));
      return isFinite(n) ? n.toFixed(2) : null;
    }
    function altMatch(carat) {
      for (var i = 0; i < media.length; i++) {
        if (media[i] && caratNum(media[i].alt) === carat) return media[i].src;
      }
      return null;
    }
    function resolveImage(carat) {
      if (!carat) return featuredImage || null;
      return serverImages[carat] || altMatch(carat) || featuredImage || null;
    }
    function setImage(url) {
      if (!el.image) return;
      if (url) {
        el.image.classList.add("is-swapping");
        var pre = new Image();
        pre.onload = function () {
          el.image.src = url;
          el.image.style.display = "";
          if (el.fallback) el.fallback.style.display = "none";
          el.image.classList.remove("is-swapping");
          updateThumbActive();
        };
        pre.onerror = function () { el.image.classList.remove("is-swapping"); };
        pre.src = url;
      } else {
        el.image.style.display = "none";
        if (el.fallback) el.fallback.style.display = "";
        updateThumbActive();
      }
    }

    function step(name) { return root.querySelector('[data-ds-step="' + name + '"]'); }
    function lock(name) { step(name).classList.add("is-locked"); }
    function unlock(name) { step(name).classList.remove("is-locked"); }

    function showMsg(text, kind) {
      if (!el.msg) return;
      el.msg.textContent = text;
      el.msg.className = "avita-ds__msg " + (kind === "ok" ? "is-ok" : "is-error");
      el.msg.hidden = false;
    }
    function clearMsg() { if (el.msg) el.msg.hidden = true; }

    // ---- chip builder ---------------------------------------------------
    function makeChips(container, values, labelFn, onPick) {
      container.innerHTML = "";
      values.forEach(function (v) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "avita-ds__chip";
        b.textContent = labelFn ? labelFn(v) : v;
        b.addEventListener("click", function () {
          Array.prototype.forEach.call(container.querySelectorAll(".avita-ds__chip"), function (c) {
            c.classList.remove("is-active");
          });
          b.classList.add("is-active");
          onPick(v);
        });
        container.appendChild(b);
      });
    }

    // ---- cascade derivations from server combos -------------------------
    function caratsFor(origin) {
      var list = combos[origin] || [];
      var cs = uniq(list.map(function (r) { return r.carat; }));
      cs.sort(function (a, b) { return parseFloat(a) - parseFloat(b); });
      return cs;
    }
    function coloursFor(origin, carat) {
      var cs = (combos[origin] || []).filter(function (r) { return r.carat === carat; })
        .map(function (r) { return r.colour; });
      cs = uniq(cs);
      cs.sort(function (a, b) { return rank(COLOUR_RANK, a) - rank(COLOUR_RANK, b); });
      return cs;
    }
    function claritiesFor(origin, carat, colour) {
      var cs = (combos[origin] || []).filter(function (r) {
        return r.carat === carat && r.colour === colour;
      }).map(function (r) { return r.clarity; });
      cs = uniq(cs);
      cs.sort(function (a, b) { return rank(CLARITY_RANK, a) - rank(CLARITY_RANK, b); });
      return cs;
    }

    // ---- resets ---------------------------------------------------------
    function resetFromCarat() {
      state.carat = null; state.colour = null; state.clarity = null;
      el.carat.value = ""; el.colour.innerHTML = ""; el.clarity.innerHTML = "";
      lock("colour"); lock("clarity");
    }

    // ---- price refresh --------------------------------------------------
    function refreshPrice() {
      var ready = state.origin && state.carat && state.colour && state.clarity;
      if (!ready) {
        el.stone.innerHTML = '<span class="avita-ds__pending">Pending selection</span>';
        el.facet.textContent = "Select to preview specification";
        el.cta.disabled = true;
        el.cta.textContent = root.querySelector("[data-ds-cta]").getAttribute("data-default") || el.cta.textContent;
        el.props.innerHTML = "<strong>Your specification</strong><br><span class='avita-ds__none'>Continue selecting above.</span>";
        return;
      }
      var url = proxyBase + "/price?productId=" + encodeURIComponent(productGid) +
        "&shape=" + encodeURIComponent(shape) +
        "&origin=" + encodeURIComponent(state.origin) +
        "&carat=" + encodeURIComponent(state.carat) +
        "&colour=" + encodeURIComponent(state.colour) +
        "&clarity=" + encodeURIComponent(state.clarity);
      // Enable Add to cart instantly — the server re-prices on add, so we don't
      // need to wait for the live total to come back.
      el.cta.disabled = false;
      el.cta.textContent = "Add to cart";
      el.stone.innerHTML = '<span class="avita-ds__pending">Calculating…</span>';
      el.facet.textContent = state.carat + "ct · " + state.colour + " · " + state.clarity +
        " · " + (state.origin === "natural" ? "Natural" : "Lab");
      el.props.innerHTML = "<strong>Your specification</strong><br>" +
        (state.origin === "natural" ? "Natural" : "Lab grown") + " " + shape + " cut · " +
        state.carat + " carat · colour " + state.colour + " · clarity " + state.clarity +
        "<br>Ring size " + (state.size || "—");

      var reqCarat = state.carat, reqColour = state.colour, reqClarity = state.clarity, reqOrigin = state.origin;
      fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { if (!r.ok) throw new Error("server"); return r.json(); })
        .then(function (data) {
          // Ignore stale responses if the shopper changed selection meanwhile.
          if (reqCarat !== state.carat || reqColour !== state.colour || reqClarity !== state.clarity || reqOrigin !== state.origin) return;
          if (!data.ok) { el.cta.disabled = true; showMsg(data.reason || "Price unavailable for this combination.", "error"); return; }
          clearMsg();
          el.base.textContent = data.baseFormatted;
          el.stone.textContent = data.stoneFormatted;
          el.total.textContent = data.totalFormatted;
          el.cta.textContent = "Add to cart · " + data.totalFormatted;
        })
        .catch(function () { showMsg("Could not reach pricing. Please retry.", "error"); });
    }

    // ---- step wiring ----------------------------------------------------
    function pickOrigin(origin) {
      state.origin = origin;
      el.hintOrigin.textContent = (origin === "natural" ? "Natural" : "Lab") + " selected";
      resetFromCarat();
      var cs = caratsFor(origin);
      el.carat.innerHTML = '<option value="">Select carat weight</option>';
      cs.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c; o.textContent = parseFloat(c).toFixed(2) + " ct";
        el.carat.appendChild(o);
      });
      unlock("carat");
      setImage(resolveImage(null)); // reset to featured until a carat is chosen
      renderThumbs(origin);
      refreshPrice();
    }

    function selectCarat(caratVal) {
      el.carat.value = caratVal || "";
      state.carat = caratVal || null;
      state.colour = null; state.clarity = null;
      el.clarity.innerHTML = ""; lock("clarity");
      setImage(resolveImage(state.carat)); // swap ring photo by carat (syncs active thumb)
      if (!state.carat) { lock("colour"); refreshPrice(); return; }
      makeChips(el.colour, coloursFor(state.origin, state.carat), null, function (v) {
        state.colour = v; state.clarity = null; el.clarity.innerHTML = "";
        makeChips(el.clarity, claritiesFor(state.origin, state.carat, state.colour), null, function (cl) {
          state.clarity = cl; unlock("size"); refreshPrice();
        });
        unlock("clarity"); refreshPrice();
      });
      unlock("colour");
      refreshPrice();
    }
    el.carat.addEventListener("change", function () { selectCarat(this.value); });

    // Thumbnails — mode chosen in block settings: per-carat images, or the
    // product's own gallery images (like a native product image switcher).
    function thumbImage(carat) {
      // Prefer the carat's own image; fall back so every carat still gets a thumb.
      return serverImages[carat] || altMatch(carat) || featuredImage || (media[0] && media[0].src) || null;
    }
    function unionCarats() {
      var seen = {};
      ["natural", "lab"].forEach(function (o) {
        (combos[o] || []).forEach(function (r) { if (r.carat) seen[r.carat] = 1; });
      });
      return Object.keys(seen).sort(function (a, b) { return parseFloat(a) - parseFloat(b); });
    }
    function selectOrigin(o) {
      var label = o === "natural" ? "Natural" : "Lab Grown";
      Array.prototype.forEach.call(el.origin.querySelectorAll(".avita-ds__chip"), function (ch) {
        if (ch.textContent === label) ch.click();
      });
    }
    function onCaratThumb(c) {
      // Carat needs an origin for pricing; auto-pick one if the shopper clicked a thumb first.
      if (!state.origin) selectOrigin((combos.natural && combos.natural.length) ? "natural" : "lab");
      selectCarat(c);
    }
    function renderCaratThumbs(origin) {
      el.thumbs.innerHTML = "";
      var carats = origin ? caratsFor(origin) : unionCarats();
      var any = false;
      carats.forEach(function (c) {
        var src = thumbImage(c);
        if (!src) return;
        any = true;
        var t = document.createElement("div");
        t.className = "avita-ds__thumb";
        t.setAttribute("data-thumb-carat", c);
        t.innerHTML = '<img src="' + src + '" alt="' + c + 'ct" loading="lazy"><span>' + parseFloat(c).toFixed(2) + "ct</span>";
        t.addEventListener("click", function () { onCaratThumb(c); });
        el.thumbs.appendChild(t);
      });
      el.thumbs.style.display = any ? "" : "none";
    }
    function renderProductThumbs() {
      el.thumbs.innerHTML = "";
      var imgs = media.filter(function (m) { return m && m.src; });
      if (!imgs.length) { el.thumbs.style.display = "none"; return; }
      el.thumbs.style.display = "";
      imgs.forEach(function (m) {
        var t = document.createElement("div");
        t.className = "avita-ds__thumb";
        t.setAttribute("data-thumb-src", m.src);
        t.innerHTML = '<img src="' + m.src + '" alt="' + (m.alt || "") + '" loading="lazy">';
        t.addEventListener("click", function () { setImage(m.src); });
        el.thumbs.appendChild(t);
      });
    }
    function renderThumbs(origin) {
      if (!el.thumbs) { console.warn("[avita-ds] thumbs container [data-ds-thumbs] NOT found — liquid is stale, redeploy."); return; }
      if (thumbSource === "product") renderProductThumbs(); else renderCaratThumbs(origin);
      console.log("[avita-ds] renderThumbs", { mode: thumbSource, origin: origin,
        mappedCarats: Object.keys(serverImages).length, thumbsBuilt: el.thumbs.children.length,
        display: el.thumbs.style.display });
      updateThumbActive();
    }
    function updateThumbActive() {
      if (!el.thumbs) return;
      var mainSrc = el.image ? el.image.getAttribute("src") : null;
      Array.prototype.forEach.call(el.thumbs.querySelectorAll(".avita-ds__thumb"), function (t) {
        var active = thumbSource === "product"
          ? t.getAttribute("data-thumb-src") === mainSrc
          : t.getAttribute("data-thumb-carat") === state.carat;
        t.classList.toggle("is-active", active);
      });
    }

    el.size.addEventListener("change", function () { state.size = this.value; refreshPrice(); });

    // ---- open the theme's own cart UI (drawer / notification) -----------
    function sectionInner(html, sel) {
      try {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var node = doc.querySelector(sel) || doc.body;
        return node ? node.innerHTML : html;
      } catch (e) { return html; }
    }
    function openThemeCart(sections) {
      // Refresh the header cart count if the theme exposes it.
      if (sections && sections["cart-icon-bubble"]) {
        var bubble = document.getElementById("cart-icon-bubble") ||
          document.querySelector(".cart-count-bubble, [data-cart-count], .cart-link__bubble");
        if (bubble) { try { bubble.innerHTML = sectionInner(sections["cart-icon-bubble"], "#cart-icon-bubble, .shopify-section"); } catch (e) { /* ignore */ } }
      }

      // Notification style (small popup — Dawn "notification" cart type).
      var note = document.querySelector("cart-notification");
      if (note && cartType === "notification") {
        if (sections && sections["cart-notification"]) { try { note.innerHTML = sectionInner(sections["cart-notification"], "cart-notification"); } catch (e) { /* ignore */ } }
        try { if (typeof note.open === "function") { note.open(); return true; } } catch (e) { /* ignore */ }
      }

      // Drawer style — Dawn, Maestrooo (Impact/Craft), Horizon and most themes.
      var drawer = document.querySelector("cart-drawer, #CartDrawer, .cart-drawer, [data-cart-drawer]");
      if (drawer) {
        // Refresh the drawer's contents from the section we requested with /cart/add.js.
        if (sections && sections["cart-drawer"]) {
          try { drawer.innerHTML = sectionInner(sections["cart-drawer"], "cart-drawer, #CartDrawer, .cart-drawer"); } catch (e) { /* ignore */ }
        }
        drawer.classList.remove("is-empty");

        // Prefer the theme's own open method (runs focus trap / overlay / scroll lock).
        var methods = ["open", "show", "showModal", "renderContents"];
        for (var i = 0; i < methods.length; i++) {
          if (typeof drawer[methods[i]] === "function") {
            try { drawer[methods[i]](); return true; } catch (e) { /* ignore */ }
          }
        }
        // Fallback to the attribute/class conventions themes use for CSS-driven drawers.
        try { drawer.setAttribute("open", ""); } catch (e) { /* ignore */ }
        drawer.removeAttribute("hidden");
        drawer.classList.add("active", "animate", "is-open", "open", "drawer--open");
        document.body.classList.add("overflow-hidden", "js-drawer-open", "cart-drawer-open");
        // Nudge themes that open/refresh their drawer on a cart event.
        try { document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true })); } catch (e) { /* ignore */ }
        return true;
      }
      return false;
    }

    // ---- add to cart ----------------------------------------------------
    el.cta.setAttribute("data-default", el.cta.textContent);
    el.cta.addEventListener("click", function () {
      if (el.cta.disabled) return;
      clearMsg();
      el.cta.disabled = true;
      var original = el.cta.textContent;
      el.cta.textContent = "Adding…";

      fetch(proxyBase + "/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          productId: productGid, shape: shape,
          origin: state.origin, carat: state.carat, colour: state.colour,
          clarity: state.clarity, size: state.size,
        }),
      })
        .then(function (r) {
          // Guard against non-JSON error pages (e.g. a 500) so we never blow up on JSON.parse.
          if (!r.ok) throw new Error("server");
          return r.json();
        })
        .then(function (data) {
          if (!data.ok) throw new Error(data.reason || "cart_failed");
          var sectionList = cartType === "notification" ? "cart-notification,cart-icon-bubble" : "cart-drawer,cart-icon-bubble";
          return fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              items: [{ id: Number(data.variantId), quantity: 1, properties: data.properties }],
              sections: sectionList,
              sections_url: window.location.pathname,
            }),
          }).then(function (r) {
            if (!r.ok) return r.json().then(function (e) { throw new Error(e.description || "add_failed"); });
            return r.json();
          });
        })
        .then(function (added) {
          // Always open the theme's cart drawer if one exists; only fall back to the
          // cart page when the theme has no drawer/notification UI at all.
          var opened = openThemeCart(added && added.sections);
          if (!opened) { window.location.href = "/cart"; return; }
          el.cta.disabled = false; el.cta.textContent = original; // ready for another add
        })
        .catch(function () {
          showMsg("Sorry, we couldn't add this to your cart. Please try again in a moment.", "error");
          el.cta.disabled = false; el.cta.textContent = original;
        });
    });

    // ---- boot: sizes + origin, then fetch valid combos ------------------
    function boot() {
      fetch(proxyBase + "/options?shape=" + encodeURIComponent(shape) + "&productId=" + encodeURIComponent(productGid), { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // Merchant toggled the selector off for this ring page.
          if (data.enabled === false) { root.style.display = "none"; return; }
          combos = data.combos || { natural: [], lab: [] };
          serverImages = data.images || {};
          console.log("[avita-ds] options loaded:", {
            enabled: data.enabled,
            naturalRows: (combos.natural || []).length,
            labRows: (combos.lab || []).length,
            sizes: (data.sizes || []).length,
            raw: data,
          });

          // ring sizes
          el.size.innerHTML = "";
          (data.sizes || []).forEach(function (s) {
            var o = document.createElement("option");
            o.value = s; o.textContent = "Size " + s;
            el.size.appendChild(o);
          });
          state.size = (data.sizes && data.sizes[0]) || null;

          // origins — only show those that actually have prices loaded
          var origins = [];
          if ((combos.natural || []).length) origins.push("natural");
          if ((combos.lab || []).length) origins.push("lab");
          if (!origins.length) { root.classList.remove("is-loading"); showMsg("No diamond prices are loaded yet.", "error"); return; }
          makeChips(el.origin, origins, function (o) { return o === "natural" ? "Natural" : "Lab Grown"; }, pickOrigin);
          renderThumbs(state.origin); // build thumbnails now that combos + images are loaded
          root.classList.remove("is-loading"); // reveal the ready selector
        })
        .catch(function () { root.classList.remove("is-loading"); showMsg("Could not load diamond options.", "error"); });
    }

    // Drag-to-scroll the thumbnail slider (desktop); touch swipe is native.
    function enableThumbDrag() {
      var t = el.thumbs;
      if (!t) return;
      var down = false, moved = false, startX = 0, startScroll = 0;
      t.addEventListener("mousedown", function (e) { down = true; moved = false; startX = e.pageX; startScroll = t.scrollLeft; });
      t.addEventListener("mousemove", function (e) {
        if (!down) return;
        var dx = e.pageX - startX;
        if (Math.abs(dx) > 4) { moved = true; t.classList.add("is-dragging"); }
        if (moved) t.scrollLeft = startScroll - dx;
      });
      window.addEventListener("mouseup", function () { down = false; t.classList.remove("is-dragging"); });
      // Cancel the click that follows a drag so it doesn't select a carat.
      t.addEventListener("click", function (e) { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    }

    enableThumbDrag();
    renderThumbs(null);
    boot();
  }

  function initAll() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-avita-ds]"), function (root) {
      if (root.__avitaInit) return;
      root.__avitaInit = true;
      initRoot(root);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
  // Re-init when Shopify theme editor injects the block.
  document.addEventListener("shopify:section:load", initAll);
})();
