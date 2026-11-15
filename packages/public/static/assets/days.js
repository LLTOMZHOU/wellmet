// Optional enhancement: switch the selected date in place.
//
// The server already puts every open day of the month on the page (hidden
// except the selected one), so a date click only needs to show another
// section. Without this script the calendar links load ?date=… pages as
// before, and agents read every day's times from the HTML either way.

const sections = document.querySelectorAll('[data-day]');

function select(link) {
  const key = link.getAttribute('data-date');
  const target = document.querySelector(`[data-day="${key}"]`);
  if (!target) return false;

  sections.forEach((section) => {
    section.hidden = section !== target;
  });
  document.querySelectorAll('a[data-date]').forEach((cell) => {
    const on = cell === link;
    cell.classList.toggle('cal__cell--selected', on);
    cell.classList.toggle('cal__cell--open', !on);
    if (on) cell.setAttribute('aria-current', 'date');
    else cell.removeAttribute('aria-current');
  });

  // Keep the address shareable and the back button sensible.
  history.replaceState(null, '', link.href);

  // On narrow screens the times sit below the calendar: bring them into view.
  const heading = target.querySelector('.day__title');
  if (target.getBoundingClientRect().top > window.innerHeight * 0.6) {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  heading?.focus({ preventScroll: true });
  return true;
}

if (sections.length) {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[data-date]');
    if (link && select(link)) event.preventDefault();
  });
}
