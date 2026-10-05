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
export type User = Profile & { id: string; role: Role };
export type Preferences = {
  bookingAlerts: boolean;
  receipts: boolean;
  networkAlerts: boolean;
  criticalAlerts: boolean;
  loadAlerts: boolean;
  reports: boolean;
};
export type Booking = {
  id: string;
  userId: string;
  stationId: string;
  connector: Connector["type"];
  start: string;
  duration: number;
  amount: number;
  payment: "card" | "sbp";
  status: "confirmed" | "cancelled" | "used";
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
  initialCharge: number;
  targetCharge: number;
  tariff: number;
  status: "active" | "completed";
  telemetry?: {
    source: "demo" | "device";
    receivedAt: string;
    connection: "online" | "offline";
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
};
