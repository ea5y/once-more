/** Start at the dialog title so opening it does not highlight the close button.
 * The title stays outside the Tab order; native modal focus trapping is retained.
 */
export function openSidebarDialog(dialog: HTMLDialogElement) {
  dialog.showModal();
  const heading = dialog.querySelector<HTMLElement>('h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}
