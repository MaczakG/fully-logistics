/* Applies the saved or system theme before the first paint (same key as fully.hu). */
(function () {
  var root = document.documentElement, saved = null, dark = false;
  root.classList.add('js');
  try { saved = localStorage.getItem('fl-theme'); } catch (e) {}
  try { dark = matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
  root.dataset.theme = saved === 'light' || saved === 'dark' ? saved : dark ? 'dark' : 'light';
})();
