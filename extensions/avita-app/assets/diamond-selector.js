
/* Avita Diamond Selector — storefront cascade + add-to-cart.
   The browser only ever sends the SELECTION. Every price is computed by the
   app server from Supabase and returned; nothing here is authoritative. */
(function () {
  var COLOUR_RANK = { D: 0, E: 1, F: 2, G: 3, H: 4, I: 5, J: 6 };
  var CLARITY_RANK = { FL: 0, IF: 1, VVS1: 2, VVS2: 3, VS1: 4, VS2: 5, SI1: 6, SI2: 7 };

  function rank(map, v) { return v in map ? map[v] : 999; }
  function uniq(arr) { return Array.prototype.filter.call(arr, function (v, i) { return arr.indexOf(v) === i; }); }

  // --- money: convert the app's GBP figures into the visitor's presentment
  // currency (Shopify Markets converts by location) so the selector matches the
  // product page + cart instead of flipping to £. Rate is derived live from the
  // ring base, which the page knows in both currencies. Preview only — the cart
  // and checkout remain authoritative (Shopify applies its own FX + rounding).
  function moneyNum(str) {
    // Pull a numeric value out of a formatted money string ("£1,314.00" -> 1314).
    var s = String(str || "").replace(/[^\d.,]/g, "");
    if (!s) return 0;
    var d = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    var tail = d > -1 ? s.length - d - 1 : 0;
    if (d > -1 && tail >= 1 && tail <= 2) {
      return parseFloat(s.slice(0, d).replace(/[.,]/g, "") + "." + s.slice(d + 1).replace(/[.,]/g, "")) || 0;
    }
    return parseFloat(s.replace(/[.,]/g, "")) || 0;
  }
  function moneyParts(str) {
    // Learn the visitor's money format from a Shopify-rendered string.
    str = String(str || "");
    var core = str.match(/\d[\d.,'’\s]*\d|\d/);
    if (!core) return null;
    var num = core[0];
    var i = str.indexOf(num);
    var dec = num.match(/[.,](\d{1,2})$/);
    var decimals = dec ? dec[1].length : 0;
    var decimalSep = dec ? num.charAt(num.length - decimals - 1) : ".";
    return {
      prefix: str.slice(0, i),
      suffix: str.slice(i + num.length),
      decimals: decimals,
      decimalSep: decimalSep,
      thousandsSep: decimalSep === "," ? "." : ",",
    };
  }
  function fmtMoney(value, p) {
    if (!p) return String(value);
    var neg = value < 0;
    value = Math.abs(Number(value) || 0);
    var fixed = value.toFixed(p.decimals);
    var bits = fixed.split(".");
    var intPart = bits[0].replace(/\B(?=(\d{3})+(?!\d))/g, p.thousandsSep);
    return (neg ? "-" : "") + p.prefix + intPart + (p.decimals ? p.decimalSep + bits[1] : "") + p.suffix;
  }

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

    // Currency: the ring base is known in BOTH currencies at load — as presentment
    // minor units (data-base-price, what the visitor sees) and, once a price comes
    // back, in GBP (the app's currency). That ratio is the visitor's FX rate, and
    // el.base's initial text teaches us how to format their currency.
    var presentBaseMinor = parseInt(root.getAttribute("data-base-price") || "0", 10);
    var moneyPat = el.base ? moneyParts(el.base.textContent) : null;
    // Debug: is Shopify exposing a currency object on this theme?
    console.log("[avita-ds] Shopify.currency:", (window.Shopify && window.Shopify.currency) || "(none)");

    // Cache of the REAL FX rate, learned from an actual cart line (see add-to-cart).
    // Keyed by the visitor's active currency so it survives reloads.
    var CUR = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || "cur";
    var RATE_KEY = "avita-fxrate:" + CUR;
    function cachedRate() {
      try { var v = parseFloat(localStorage.getItem(RATE_KEY)); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
    }
    function cacheRate(v) {
      try { if (isFinite(v) && v > 0) localStorage.setItem(RATE_KEY, String(v)); } catch (e) { /* ignore */ }
    }

    // Convert the app's GBP figures to the visitor's currency for display.
    function toPresentment(data) {
      var baseGBP = moneyNum(data.baseFormatted);
      var stoneGBP = moneyNum(data.stoneFormatted);
      var presentBase = presentBaseMinor / 100;
      var derived = baseGBP > 0 ? presentBase / baseGBP : 0;
      // No presentment info, or the visitor is already in the store's base
      // currency (rate ~1) — show the app's exact strings, no conversion.
      if (!moneyPat || !isFinite(derived) || derived <= 0 || Math.abs(derived - 1) < 0.01) {
        return { base: data.baseFormatted, stone: data.stoneFormatted, total: data.totalFormatted };
      }
      // Prefer the rate LEARNED from a real cart line over the rate derived from
      // the already-rounded base. Guard against garbage (>10% off).
      var rate = derived;
      var cr = cachedRate();
      if (cr && Math.abs(cr - derived) / derived < 0.1) rate = cr;
      // Every rate we can sample carries rounding noise (each source price is
      // itself rounded to 100). Markets stores use a clean fixed rate, so snap
      // large rates to 1 dp — this recovers e.g. 168.0 from 168.036/167.994 and
      // makes the preview match the cart. Small rates (<10) keep full precision.
      if (rate >= 10) rate = Math.round(rate * 10) / 10;
      // Round to the currency's granularity so we don't show false precision.
      // A whole-hundred base (e.g. BDT) means Shopify rounds to 100 as well.
      var gran = presentBase >= 1000 && presentBase % 100 === 0 ? 100 : 1;
      function r(v) { return gran > 1 ? Math.round(v / gran) * gran : Math.round(v); }
      return {
        base: fmtMoney(r(baseGBP * rate), moneyPat),
        stone: fmtMoney(r(stoneGBP * rate), moneyPat),
        total: fmtMoney(r((baseGBP + stoneGBP) * rate), moneyPat),
      };
    }

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
    // Compact block has no image panel of its own — swap the THEME's main product
    // image instead (best-effort; selectors vary by theme). Set both src and
    // srcset so the browser doesn't keep showing the responsive original.
    function swapThemeMedia(url) {
      if (!url) return;
      var sels = [
        ".product-gallery__media img",   // Maestrooo scroll-carousel (this theme)
        "media-gallery img", "product-media img", ".product-media img",
        ".product__media img", "[data-product-media-wrapper] img",
        ".product__media-item img", ".product-single__photo img",
      ];
      var img = null;
      for (var i = 0; i < sels.length && !img; i++) img = document.querySelector(sels[i]);
      if (!img) return;
      // Drop the responsive srcset/sizes so the browser shows exactly our URL.
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.removeAttribute("data-srcset");
      img.setAttribute("src", url);
      // If it's a scroll carousel, snap back to the (now-swapped) first slide.
      var car = document.querySelector(".product-gallery__carousel, scroll-carousel, .product-gallery__image-list .scroll-area");
      if (car) { try { car.scrollTo({ left: 0, behavior: "smooth" }); } catch (e) { car.scrollLeft = 0; } }
    }
    function setImage(url) {
      if (!el.image) { swapThemeMedia(url); return; }
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
        if (el.stone) el.stone.innerHTML = '<span class="avita-ds__pending">Pending selection</span>';
        if (el.facet) el.facet.textContent = "Select to preview specification";
        el.cta.disabled = true;
        el.cta.textContent = root.querySelector("[data-ds-cta]").getAttribute("data-default") || el.cta.textContent;
        if (el.props) el.props.innerHTML = "<strong>Your specification</strong><br><span class='avita-ds__none'>Continue selecting above.</span>";
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
      if (el.stone) el.stone.innerHTML = '<span class="avita-ds__pending">Calculating…</span>';
      if (el.facet) el.facet.textContent = state.carat + "ct · " + state.colour + " · " + state.clarity +
        " · " + (state.origin === "natural" ? "Natural" : "Lab");
      if (el.props) el.props.innerHTML = "<strong>Your specification</strong><br>" +
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
          var m = toPresentment(data); // show the visitor's currency, not raw GBP
          if (el.base) el.base.textContent = m.base;
          if (el.stone) el.stone.textContent = m.stone;
          if (el.total) el.total.textContent = m.total;
          el.cta.textContent = "Add to cart · " + m.total;
        })
        .catch(function () { showMsg("Could not reach pricing. Please retry.", "error"); });
    }

    // ---- step wiring ----------------------------------------------------
    function pickOrigin(origin) {
      state.origin = origin;
      if (el.hintOrigin) el.hintOrigin.textContent = (origin === "natural" ? "Natural" : "Lab") + " selected";
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
      if (!el.thumbs) return; // compact block has no gallery — nothing to build
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
        // Replace the WHOLE drawer element with the freshly-rendered one. Injecting
        // innerHTML strips the element's own slot structure (header/footer) and
        // leaves an empty gap at the top; swapping the element keeps it intact.
        if (sections && sections["cart-drawer"]) {
          try {
            var doc2 = new DOMParser().parseFromString(sections["cart-drawer"], "text/html");
            var fresh = doc2.querySelector("cart-drawer, #CartDrawer, .cart-drawer");
            if (fresh && drawer.parentNode) { drawer.replaceWith(fresh); drawer = fresh; }
            else if (!fresh) { drawer.innerHTML = sectionInner(sections["cart-drawer"], "cart-drawer, #CartDrawer, .cart-drawer"); }
          } catch (e) { /* ignore */ }
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

    // Remember each minted line's image so we can repaint EVERY one of our lines
    // whenever the drawer re-renders (a new add re-renders the whole drawer and
    // would otherwise wipe earlier lines). sessionStorage survives reloads.
    var LINE_IMG_KEY = "avita-line-imgs";
    function readLineImgs() {
      try { return JSON.parse(sessionStorage.getItem(LINE_IMG_KEY) || "{}") || {}; } catch (e) { return {}; }
    }
    function rememberLineImg(variantId, url) {
      if (!variantId || !url) return;
      try { var m = readLineImgs(); m[variantId] = url; sessionStorage.setItem(LINE_IMG_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
    }
    // Set (or create) the photo for one cart line. No-op unless we can pin the
    // exact line by its variant id, so we never touch the wrong line.
    function injectLineImage(variantId, url) {
      if (!variantId || !url) return;
      var scope = document.querySelector("cart-drawer, #CartDrawer, .cart-drawer, [data-cart-drawer], cart-notification") || document;
      var hit = scope.querySelector(
        'a[href*="variant=' + variantId + '"], [data-line-key^="' + variantId + ':"], ' +
        '[data-variant-id="' + variantId + '"], [data-cart-item-variant-id="' + variantId + '"]',
      );
      if (!hit) return;
      var line = (hit.closest && hit.closest("line-item, .line-item, .cart-item, .cart-drawer__item, li, tr, .cart__row")) || hit.parentNode;
      if (!line || !line.querySelector) return;
      var img = line.querySelector("img");
      if (img) {
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        img.setAttribute("src", url);
        return;
      }
      // Theme rendered no <img> (product has no media) — drop one into the line's
      // media slot so the line isn't blank.
      var slot = line.querySelector(".line-item__media, .cart-item__media, .cart-item__image, .cart__image, [class*='__media'], [class*='__image']");
      if (!slot) return;
      var made = document.createElement("img");
      made.src = url;
      made.alt = "";
      made.loading = "lazy";
      made.style.width = "100%";
      made.style.height = "100%";
      made.style.objectFit = "cover";
      if (slot.tagName === "IMG") { slot.replaceWith(made); } else { slot.appendChild(made); }
    }
    // Repaint every one of our lines currently in the drawer.
    function paintLineImages() {
      var m = readLineImgs();
      Object.keys(m).forEach(function (vid) { injectLineImage(vid, m[vid]); });
    }

    // ---- add to cart ----------------------------------------------------
    el.cta.setAttribute("data-default", el.cta.textContent);
    el.cta.addEventListener("click", function () {
      if (el.cta.disabled) return;
      clearMsg();
      el.cta.disabled = true;
      var original = el.cta.textContent;
      el.cta.textContent = "Adding…";
      var lineImageUrl = resolveImage(state.carat) || featuredImage || null;
      var addedVariantId = null;
      var addedTotalGBP = 0;

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
          addedVariantId = data.variantId;
          addedTotalGBP = moneyNum(data.totalFormatted); // GBP total for the FX-rate learning below
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
          // Learn the REAL FX rate from the cart line: it's Shopify's exact
          // converted price for a variant whose GBP total we know. Cache it so the
          // next price preview matches the cart precisely (no ~100 rounding gap).
          try {
            var ln = added && (added.items ? added.items[0] : added);
            var presCents = ln && (ln.final_line_price || ln.line_price || ln.price);
            if (presCents && addedTotalGBP > 0) {
              var learned = presCents / 100 / addedTotalGBP;
              cacheRate(learned);
              console.log("[avita-ds] learned FX rate:", learned, "→ cached for", CUR);
            }
          } catch (e) { /* ignore */ }

          rememberLineImg(addedVariantId, lineImageUrl);
          var opened = openThemeCart(added && added.sections);
          if (!opened) { window.location.href = "/cart"; return; }
          // Paint ALL our lines now, and once more after the theme settles/re-renders.
          paintLineImages();
          setTimeout(paintLineImages, 250);
          // Keep the "Adding…" loader on the button until the drawer has slid open,
          // so it never disappears a beat before the cart is visible.
          setTimeout(function () {
            el.cta.disabled = false; el.cta.textContent = original; // ready for another add
          }, 450);
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

    // Size guide: intercept the link and open the in-page modal when the
    // block is configured in "modal" mode. Falls back to the link's default
    // new-tab behaviour if the modal markup is not present.
    (function wireSizeGuide() {
      var link = root.querySelector("[data-ds-sizeguide]");
      var modal = root.querySelector("[data-ds-sg-modal]");
      if (!link || !modal) return;
      function open(e) {
        if (e) e.preventDefault();
        modal.hidden = false;
        document.addEventListener("keydown", onKey);
      }
      function close() {
        modal.hidden = true;
        document.removeEventListener("keydown", onKey);
      }
      function onKey(e) { if (e.key === "Escape" || e.keyCode === 27) close(); }
      link.addEventListener("click", open);
      Array.prototype.forEach.call(modal.querySelectorAll("[data-ds-sg-close]"), function (b) {
        b.addEventListener("click", close);
      });
    })();

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
