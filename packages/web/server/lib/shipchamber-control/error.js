export class ShipChamberControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'ShipChamberControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof ShipChamberControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new ShipChamberControlError(message || fallbackMessage, Number(error?.statusCode) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
