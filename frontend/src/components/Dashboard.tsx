import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { 
  Sparkles, 
  LogOut, 
  Server, 
  CheckCircle2, 
  AlertCircle, 
  Store, 
  Key, 
  Layers, 
  Activity 
} from "lucide-react";

export const Dashboard: React.FC = () => {
  const { user, session, signOut, fetchWithAuth } = useAuth();
  const [backendStatus, setBackendStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [backendResponse, setBackendResponse] = useState<any>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  const testBackendConnection = async () => {
    setBackendStatus("loading");
    setBackendError(null);
    try {
      const res = await fetchWithAuth("/api/auth/me");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || `Request failed with status ${res.status}`);
      }

      setBackendResponse(data);
      setBackendStatus("success");
    } catch (err: any) {
      console.error("Backend test failed:", err);
      setBackendError(err.message || "Failed to reach Bun Express backend.");
      setBackendStatus("error");
    }
  };

  const storeName = user?.user_metadata?.store_name || "Merchant Store";
  const fullName = user?.user_metadata?.full_name || "Merchant Operator";

  return (
    <div className="dashboard-layout">
      {/* Top Navigation */}
      <header className="dashboard-nav">
        <div className="nav-brand">
          <div className="brand-icon-wrapper">
            <Sparkles className="brand-icon" size={20} />
          </div>
          <div>
            <div className="brand-name-row">
              <span className="brand-name">Mercora</span>
              <span className="brand-tag">OS v1.0</span>
            </div>
            <p className="brand-subtext">AI-Native Merchant Operating System</p>
          </div>
        </div>

        <div className="nav-user-controls">
          <div className="user-pill">
            <Store size={16} className="pill-icon" />
            <span>{storeName}</span>
          </div>
          <button onClick={signOut} className="btn-logout" title="Sign Out">
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="dashboard-main">
        {/* Welcome Banner */}
        <section className="welcome-card">
          <div className="welcome-header">
            <div>
              <div className="status-badge">
                <span className="pulse-dot" />
                <span>Supabase Auth & Session Active</span>
              </div>
              <h2 className="welcome-title">Welcome back, {fullName}</h2>
              <p className="welcome-desc">
                Your Merchant Brain is connected. Operating loops for Growth, CRM, Finance, and Commerce are ready.
              </p>
            </div>
            <div className="welcome-stats">
              <div className="stat-box">
                <span className="stat-label">Auth Provider</span>
                <span className="stat-val">Supabase (Postgres)</span>
              </div>
              <div className="stat-box">
                <span className="stat-label">Backend Runtime</span>
                <span className="stat-val">Bun + Express (TS)</span>
              </div>
            </div>
          </div>
        </section>

        {/* 2-Column Info Grid */}
        <div className="grid-2col">
          {/* User & Auth Details */}
          <div className="card">
            <div className="card-header">
              <div className="card-header-icon">
                <Key size={18} />
              </div>
              <h3>Active Session Details</h3>
            </div>
            <div className="card-body">
              <div className="info-row">
                <span className="info-label">User ID:</span>
                <code className="code-snippet">{user?.id}</code>
              </div>
              <div className="info-row">
                <span className="info-label">Email:</span>
                <span className="info-value">{user?.email}</span>
              </div>
              {user?.phone && (
                <div className="info-row">
                  <span className="info-label">Phone:</span>
                  <span className="info-value">{user.phone}</span>
                </div>
              )}
              <div className="info-row">
                <span className="info-label">Last Sign In:</span>
                <span className="info-value">
                  {user?.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : "Just now"}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">JWT Token (Bearer):</span>
                <code className="code-snippet truncate">
                  {session?.access_token ? `${session.access_token.substring(0, 32)}...` : "None"}
                </code>
              </div>
            </div>
          </div>

          {/* Backend Integration Test */}
          <div className="card">
            <div className="card-header">
              <div className="card-header-icon">
                <Server size={18} />
              </div>
              <h3>Backend Auth Middleware Test</h3>
            </div>
            <div className="card-body">
              <p className="card-desc">
                Click below to send an authenticated request with your Supabase Bearer token to the Bun Express backend route: <code>GET /api/auth/me</code>.
              </p>
              
              <button 
                onClick={testBackendConnection} 
                disabled={backendStatus === "loading"}
                className="btn-primary"
              >
                {backendStatus === "loading" ? (
                  <div className="spinner-sm" />
                ) : (
                  <>
                    <Activity size={16} />
                    <span>Verify Backend /api/auth/me</span>
                  </>
                )}
              </button>

              {backendStatus === "success" && (
                <div className="test-result success">
                  <div className="result-header">
                    <CheckCircle2 size={16} className="text-emerald" />
                    <strong>Backend Verified (200 OK)</strong>
                  </div>
                  <pre className="json-block">
                    {JSON.stringify(backendResponse, null, 2)}
                  </pre>
                </div>
              )}

              {backendStatus === "error" && (
                <div className="test-result error">
                  <div className="result-header">
                    <AlertCircle size={16} className="text-rose" />
                    <strong>Verification Failed</strong>
                  </div>
                  <p className="error-text">{backendError}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Operating Loops Architecture Preview */}
        <section className="architecture-section">
          <div className="arch-header">
            <Layers size={20} className="text-indigo" />
            <h3>Mercora Operating Loops Preview</h3>
          </div>
          <div className="loops-grid">
            <div className="loop-card">
              <div className="loop-pill green">Growth Loop</div>
              <h4>Demand & Campaigns</h4>
              <p>Meta Ads, Catalog Signals, WhatsApp Outreach</p>
            </div>
            <div className="loop-card">
              <div className="loop-pill blue">CRM Loop</div>
              <h4>Customer Intelligence</h4>
              <p>Conversations, WhatsApp support, Recovery</p>
            </div>
            <div className="loop-card">
              <div className="loop-pill amber">Finance Loop</div>
              <h4>Reconciliation</h4>
              <p>Shopify, Razorpay settlements, Bank credits</p>
            </div>
            <div className="loop-card">
              <div className="loop-pill purple">Commerce Loop</div>
              <h4>Storefront & Catalog</h4>
              <p>Agentic storefronts, UPI checkouts, AOV</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};
