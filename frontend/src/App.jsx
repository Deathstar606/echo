import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import TopHeader from './components/TopHeader';
import LandingPage from './pages/LandingPage';
import CustomerPortal from './pages/CustomerPortal';
import CompanyDashboard from './pages/CompanyDashboard';

export default function App() {
  return (
    <div className="app-shell">
      <TopHeader />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/customer" element={<CustomerPortal />} />
        <Route path="/company" element={<CompanyDashboard />} />
        <Route path="*" element={<Navigate to="/company" replace />} />
      </Routes>
    </div>
  );
}
