import {
  BrowserRouter,
  HashRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { useEffect } from "react";
import { AppProvider, ProtectedRoute } from "./state/AppProvider";
import "./App.css";
import "./styles/flows.css";
import {
  BookingPage,
  BookingsPage,
  SessionsPage,
  PaymentResultPage,
  ChargingPage,
  DriverMapPage,
  DriverProfilePage,
  DriverSettingsPage,
  LandingPage,
  LoginPage,
  NotFoundPage,
  OperatorDashboardPage,
  OperatorPowerPage,
  OperatorSessionsPage,
  OperatorSettingsPage,
  OperatorStationsPage,
  RegisterPage,
  StationPage,
  RecoveryPage,
  ResetPasswordPage,
  CheckoutPage,
} from "./pages";

// Static hosts such as GitHub Pages cannot serve arbitrary application routes.
const Router =
  import.meta.env.VITE_ROUTER_MODE === "hash" ? HashRouter : BrowserRouter;

function ScrollRestoration() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const anchor = hash ? document.getElementById(hash.slice(1)) : null;
    if (anchor) {
      anchor.scrollIntoView({ block: "start", behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [pathname, hash]);
  return null;
}

export default function App() {
  return (
    <Router>
      <AppProvider>
        <ScrollRestoration />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<RecoveryPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<ProtectedRoute role="driver" />}>
            <Route path="/driver/stations" element={<DriverMapPage />} />
            <Route
              path="/driver/stations/:stationId"
              element={<StationPage />}
            />
            <Route path="/driver/booking" element={<BookingPage />} />
            <Route
              path="/driver/checkout/:paymentId"
              element={<CheckoutPage />}
            />
            <Route path="/driver/charging" element={<ChargingPage />} />
            <Route path="/driver/bookings" element={<BookingsPage />} />
            <Route path="/driver/sessions" element={<SessionsPage />} />
            <Route
              path="/driver/payment/:bookingId"
              element={<PaymentResultPage />}
            />
            <Route path="/driver/profile" element={<DriverProfilePage />} />
            <Route path="/driver/settings" element={<DriverSettingsPage />} />
          </Route>
          <Route element={<ProtectedRoute role="operator" />}>
            <Route path="/operator" element={<OperatorDashboardPage />} />
            <Route
              path="/operator/stations"
              element={<OperatorStationsPage />}
            />
            <Route
              path="/operator/sessions"
              element={<OperatorSessionsPage />}
            />
            <Route path="/operator/power" element={<OperatorPowerPage />} />
            <Route
              path="/operator/settings"
              element={<OperatorSettingsPage />}
            />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppProvider>
    </Router>
  );
}
