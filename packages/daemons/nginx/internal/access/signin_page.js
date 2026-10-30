(function () {
  "use strict";
  document.documentElement.classList.add("js");
  // The toast's close button.
  document.addEventListener("click", function (event) {
    var close = event.target && event.target.closest ? event.target.closest("[data-toast-close]") : null;
    if (!close) return;
    var toast = close.closest("[data-toast]");
    if (toast) {
      toast.classList.add("is-closing");
      setTimeout(function () { toast.hidden = true; }, 400);
    }
  });
  var box = document.querySelector("[data-height]");
  var steps = document.querySelector("[data-steps]");
  var subtitle = document.querySelector("[data-subtitle]");
  if (!box || !steps) return;
  var reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var SPINNER = '<svg class="spinner" viewBox="0 0 24 24" aria-hidden="true" data-spinner><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  var busy = false;
  var timers = [];

  function stepNamed(name) {
    return steps.querySelector('[data-step="' + name + '"]');
  }
  function shown() {
    return steps.querySelector("[data-step]:not([hidden]):not(.step-leave)");
  }
  function focusFirst(section) {
    var field = section.querySelector("input:not([type=hidden])");
    if (field) {
      try { field.focus({ preventScroll: true }); } catch (e) { field.focus(); }
    }
  }
  function settle() {
    while (timers.length) clearTimeout(timers.pop());
    var leaving = steps.querySelectorAll(".step-leave");
    for (var i = 0; i < leaving.length; i++) {
      leaving[i].hidden = true;
      leaving[i].classList.remove("step-leave");
    }
    var entering = steps.querySelectorAll(".step-enter");
    for (var j = 0; j < entering.length; j++) entering[j].classList.remove("step-enter");
    box.style.height = "";
  }

  // Steps switch in place: the leaving one slides out, the new one slides in, the box follows its height.
  function show(name) {
    var from = shown();
    var to = stepNamed(name);
    if (!to || to === from) return;
    settle();
    if (subtitle && to.getAttribute("data-title")) subtitle.textContent = to.getAttribute("data-title");
    if (from) {
      var secrets = from.querySelectorAll("input[type=password]");
      for (var i = 0; i < secrets.length; i++) secrets[i].value = "";
    }
    if (!from || (reduced && reduced.matches)) {
      if (from) from.hidden = true;
      to.hidden = false;
      focusFirst(to);
      return;
    }
    var start = box.offsetHeight;
    from.classList.add("step-leave");
    to.hidden = false;
    to.classList.add("step-enter");
    var end = steps.offsetHeight + paddingOf(box);
    box.style.height = start + "px";
    void box.offsetHeight;
    box.style.height = end + "px";
    focusFirst(to);
    timers.push(setTimeout(function () {
      from.hidden = true;
      from.classList.remove("step-leave");
      to.classList.remove("step-enter");
    }, 180));
    timers.push(setTimeout(function () { box.style.height = ""; }, 250));
  }
  function paddingOf(element) {
    var style = window.getComputedStyle(element);
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  }

  // A button that submits or leaves the page shows a spinner and holds the others until the page is gone.
  function hold(control) {
    busy = true;
    var controls = document.querySelectorAll(".btn");
    for (var i = 0; i < controls.length; i++) {
      var other = controls[i];
      if (other === control) continue;
      other.classList.add("is-disabled");
      other.setAttribute("aria-disabled", "true");
    }
    if (!control) return;
    control.classList.add("is-pending");
    control.setAttribute("aria-busy", "true");
    control.insertAdjacentHTML("afterbegin", SPINNER);
    setTimeout(function () {
      for (var j = 0; j < controls.length; j++) {
        if (controls[j].tagName === "BUTTON") controls[j].disabled = true;
      }
    }, 0);
  }
  function release() {
    busy = false;
    var controls = document.querySelectorAll(".btn");
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      control.classList.remove("is-disabled", "is-pending");
      control.removeAttribute("aria-disabled");
      control.removeAttribute("aria-busy");
      if (control.tagName === "BUTTON") control.disabled = false;
      var spinner = control.querySelector("[data-spinner]");
      if (spinner) spinner.parentNode.removeChild(spinner);
    }
  }
  function plainClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (busy && target.closest(".btn")) {
      event.preventDefault();
      return;
    }
    var step = target.closest("[data-goto]");
    if (step && plainClick(event)) {
      event.preventDefault();
      show(step.getAttribute("data-goto"));
      return;
    }
    var leave = target.closest("[data-leave]");
    if (leave && plainClick(event)) hold(leave);
  });
  document.addEventListener("submit", function (event) {
    if (busy) {
      event.preventDefault();
      return;
    }
    var form = event.target;
    hold(event.submitter || (form.querySelector && form.querySelector("[type=submit]")));
  });
  // Back from the provider or after a redirect, the page may come from the back-forward cache as it was left.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) release();
  });
})();
