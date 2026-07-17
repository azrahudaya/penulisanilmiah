export const whatsappRuntime = {
  status: 'starting',
  qrDataUrl: '',
  updatedAt: Date.now(),
};

export function setWhatsappRuntime(values) {
  Object.assign(whatsappRuntime, values, { updatedAt: Date.now() });
}
