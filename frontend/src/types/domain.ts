import type { Connector, Station } from "../data";

export type Role = "driver" | "operator";
export type Profile = {
  name: string;
  email: string;
  phone: string;
  vehicle: string;
  plate: string;
  connector: Connector["type"];
  battery: number;
};
// Operators have no vehicle. Driver auth/profile responses include every Profile field.
export type User = Pick<Profile, "name" | "email" | "phone"> &
  Partial<Omit<Profile, "name" | "email" | "phone">> & {
    id: string;
    role: Role;
  };
export type Preferences = {
  bookingAlerts: boolean;
  receipts: boolean;
  networkAlerts: boolean;
  criticalAlerts: boolean;
  loadAlerts: boolean;
  reports: boolean;
};
export type Booking = {
  paymentId?: string;
  reservationId?: string;
  connectorId?: string;
  id: string;
  userId: string;
  stationId: string;
  connector: Connector["type"];
  start: string;
  duration: number;
  amount: number;
  payment: "card" | "sbp";
  status: "confirmed" | "cancelled" | "expired" | "used";
  closureReason?: "driver" | "no_show" | "session" | null;
  closedAt?: string | null;
  sessionId?: string | null;
  sessionStatus?: Session["status"] | null;
  refund?: {
    id: string;
    amountKopecks: number;
    status: "pending" | "submitted" | "succeeded";
    confirmedAt: string | null;
    test: true;
  } | null;
  createdAt: string;
};
export type Session = {
  id: string;
  userId: string;
  bookingId: string;
  stationId: string;
  connector: Connector["type"];
  startedAt: string;
  meteredAt: string;
  batteryCapacity: number;
  endedAt: string | null;
  energy: number;
  power: number;
  initialCharge: number | null;
  targetCharge: number | null;
  tariff: number;
  status: "starting" | "active" | "stopping" | "completed" | "failed";
  source?: "simulator";
  connectorId?: string;
  requestedAt?: string;
  startConfirmedAt?: string | null;
  currentPowerKw?: number | null;
  energyWh?: number;
  energyBudgetWh?: number;
  costKopecks?: number;
  tariffKopecks?: number;
  prepaidKopecks?: number;
  soc?: number | null;
  telemetryGap?: boolean;
  stopReason?: string | null;
  settlement?: {
    id: string;
    energyWh: number;
    tariffKopecks: number;
    prepaidKopecks: number;
    finalCostKopecks: number;
    unusedKopecks: number;
    reason: string;
    source: "simulator";
    createdAt: string;
  } | null;
  refund?: {
    id: string;
    amountKopecks: number;
    status: "pending" | "submitted" | "succeeded";
    confirmedAt: string | null;
    test: boolean;
  } | null;
  telemetry?: {
    source: "demo" | "device" | "simulator";
    receivedAt: string;
    connection: "online" | "offline" | "stale";
    energy: number;
  };
};
export type NetworkEvent = {
  id: string;
  stationId: string | null;
  date: string;
  message: string;
  severity: "info" | "warning" | "danger";
};
export type Forecast = {
  source: "demo" | "model";
  generatedAt: string;
  points: { time: string; powerKw: number }[];
};
export type Snapshot = {
  operatorManagement?: boolean;
  charging?: boolean;
  stage?: "foundation" | "bookings";
  stations: Station[];
  bookings: Booking[];
  sessions: Session[];
  preferences: Preferences;
  networkLimit: number;
  organization: string;
  events: NetworkEvent[];
  forecast: Forecast | null;
  payments?: Payment[];
};
export type Credentials = { email: string; password: string; role: Role };
export type Registration = Profile & { password: string };
export type BookingInput = Pick<
  Booking,
  "stationId" | "connector" | "start" | "duration" | "payment"
>;
export type AuthResult = { user: User; token: string };
export type RecoveryResult = { message: string; demoResetToken?: string };
export type Payment = {
  id: string;
  userId: string;
  input: BookingInput;
  amount: number;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  bookingId: string | null;
  createdAt: string;
  expiresAt: string;
  failure: string | null;
  confirmationUrl?: string;
  test?: boolean;
  providerSuccessReceived?: boolean;
  awaitingFinalization?: boolean;
  reconciliationRequired?: boolean;
  finalizationReason?: string | null;
  refunds?: {
    id: string;
    status: "pending" | "submitted" | "succeeded";
    reason: string;
    amount: number;
    confirmedAt: string | null;
    test: boolean;
  }[];
  attempt?: {
    id: string;
    number: number;
    status: "pending" | "succeeded" | "failed" | "cancelled" | "expired";
  };
};
