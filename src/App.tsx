import React, { useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { LeadsPage } from "./pages/LeadsPage";
import { CampaignPage } from "./pages/CampaignPage";
import { InboxPage } from "./pages/InboxPage";
import { QueuePage } from "./pages/QueuePage";
import { CompliancePage } from "./pages/CompliancePage";
import { LangProvider } from "./utils/LangContext";
import { Login } from "./components/Login";
import "./styles/global.css";

export default function App() {
  const [authed, setAuthed] = useState(
    localStorage.getItem("luminal_auth") === "true"
  );

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  return (
    <LangProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/leads" replace />} />
            <Route path="leads" element={<LeadsPage />} />
            <Route path="campaign" element={<CampaignPage />} />
            <Route path="inboxes" element={<InboxPage />} />
            <Route path="queue" element={<QueuePage />} />
            <Route path="compliance" element={<CompliancePage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </LangProvider>
  );
}
