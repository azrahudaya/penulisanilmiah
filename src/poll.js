export function findPollOptionName(selectedOption, pollOptions = []) {
  if (selectedOption?.name) return String(selectedOption.name).toLowerCase();
  const match = pollOptions.find((option) => String(option.localId) === String(selectedOption?.localId));
  return String(match?.name || '').toLowerCase();
}
