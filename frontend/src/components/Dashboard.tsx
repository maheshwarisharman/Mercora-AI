import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { 
  Sparkles, 
  LogOut, 
  Store, 
  Calculator,
} from "lucide-react";
import { FinanceMissionView } from "./FinanceMissionView";

export const Dashboard: React.FC = () => {
  const { user, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<"overview" | "finance">("finance");

  const storeName = user?.user_metadata?.store_name || "Merchant Store";

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

        <div className="nav-tabs-wrapper">
          <button
            onClick={() => setActiveTab("finance")}
            className={`nav-tab-btn ${activeTab === "finance" ? "active" : ""}`}
          >
            <Calculator size={16} />
            <span>Finance Agent</span>
          </button>
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
        {activeTab === "finance" ? (
          <FinanceMissionView />
        ) : (
          <div className="p-6">Overview</div>
        )}
      </main>
    </div>
  );
};
