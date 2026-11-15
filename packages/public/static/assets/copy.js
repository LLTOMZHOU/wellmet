// Optional enhancement: a Copy button for the assistant line. Without this
// script the line is still selectable text (user-select: all).
document.querySelectorAll('[data-copy]').forEach((button) => {
  const target = document.getElementById(button.getAttribute('data-copy'));
  if (!target || !navigator.clipboard) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = 'Copied';
      button.setAttribute('data-done', '');
    } catch {
      button.textContent = 'Select it';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
      button.removeAttribute('data-done');
    }, 2000);
  });
});
