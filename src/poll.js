export function findPollOptionName(selectedOption, pollOptions = []) {
  if (selectedOption?.name) return String(selectedOption.name).toLowerCase();
  const match = pollOptions.find((option) => String(option.localId) === String(selectedOption?.localId));
  return String(match?.name || '').toLowerCase();
}

export function canMatchRegistrationVoteByChat(respondent) {
  if (respondent?.registration_step === 'consent') return !respondent.consent_poll_message_id;
  if (respondent?.registration_step === 'gender') return !respondent.gender_poll_message_id;
  return false;
}

export function findSentPollMessage(messages, pollName) {
  return [...messages].reverse().find((message) => (
    message?.fromMe && message.type === 'poll_creation' && message.body === pollName
  ));
}
