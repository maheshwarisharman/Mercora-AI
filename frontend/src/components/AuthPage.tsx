import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { isConfigured } from "../lib/supabase";
import { 
  ShieldCheck, 
  Store, 
  Mail, 
  Lock, 
  User as UserIcon, 
  ArrowRight, 
  Sparkles, 
  AlertCircle, 
  CheckCircle2,
  Phone
} from "lucide-react";

export const AuthPage: React.FC = () => {
  const { signInWithPassword, signUp, signInWithOtp } = useAuth();
  
  const [mode, setMode] = useState<"login" | "signup" | "magic_link">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [phone, setPhone] = useState("");
  
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (mode === "login") {
        const { error } = await signInWithPassword(email, password);
        if (error) throw error;
      } else if (mode === "signup") {
        const { error } = await signUp(email, password, {
          full_name: fullName,
          store_name: storeName,
          phone: phone,
        });
        if (error) throw error;
        setSuccessMsg("Account created! If email confirmation is enabled in Supabase, please check your inbox.");
      } else if (mode === "magic_link") {
        const { error } = await signInWithOtp(email);
        if (error) throw error;
        setSuccessMsg("Magic link sent! Please check your email to sign in.");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Authentication failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      {/* Background glow effects */}
      <div className="ambient-glow glow-1" />
      <div className="ambient-glow glow-2" />

      <div className="auth-card">
        {/* Header Branding */}
        <div className="auth-header">
          <div className="brand-badge">
            <div className="brand-icon-wrapper">
              <Sparkles className="brand-icon" size={20} />
            </div>
            <span className="brand-name">Mercora</span>
            <span className="brand-tag">Merchant OS</span>
          </div>

          <h1 className="auth-title">
            {mode === "login" && "Welcome back"}
            {mode === "signup" && "Create your merchant account"}
            {mode === "magic_link" && "Sign in with Magic Link"}
          </h1>
          <p className="auth-subtitle">
            {mode === "login" && "Enter your merchant credentials to access your operating loops"}
            {mode === "signup" && "Join Mercora to power Growth, CRM, Finance & Commerce with AI"}
            {mode === "magic_link" && "We'll send a secure one-click sign in link to your email"}
          </p>
        </div>

        {/* Configuration Notice if Supabase keys not set */}
        {!isConfigured && (
          <div className="config-banner">
            <AlertCircle size={18} className="config-banner-icon" />
            <div className="config-banner-text">
              <strong>Supabase credentials not configured:</strong> Set <code>VITE_SUPABASE_URL</code> & <code>VITE_SUPABASE_ANON_KEY</code> in <code>frontend/.env</code>.
            </div>
          </div>
        )}

        {/* Mode Switcher Tabs */}
        <div className="auth-tabs">
          <button
            type="button"
            className={`tab-btn ${mode === "login" ? "active" : ""}`}
            onClick={() => { setMode("login"); setErrorMsg(null); setSuccessMsg(null); }}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === "signup" ? "active" : ""}`}
            onClick={() => { setMode("signup"); setErrorMsg(null); setSuccessMsg(null); }}
          >
            Create Account
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === "magic_link" ? "active" : ""}`}
            onClick={() => { setMode("magic_link"); setErrorMsg(null); setSuccessMsg(null); }}
          >
            Magic Link
          </button>
        </div>

        {/* Alerts */}
        {errorMsg && (
          <div className="alert alert-error">
            <AlertCircle size={18} />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="alert alert-success">
            <CheckCircle2 size={18} />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="auth-form">
          {mode === "signup" && (
            <>
              <div className="form-group">
                <label htmlFor="fullName">Merchant Name</label>
                <div className="input-wrapper">
                  <UserIcon className="input-icon" size={18} />
                  <input
                    id="fullName"
                    type="text"
                    placeholder="e.g. Rahul Sharma"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="storeName">Store / Brand Name</label>
                <div className="input-wrapper">
                  <Store className="input-icon" size={18} />
                  <input
                    id="storeName"
                    type="text"
                    placeholder="e.g. Artisanal Roasters"
                    value={storeName}
                    onChange={(e) => setStoreName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="phone">Phone Number (WhatsApp)</label>
                <div className="input-wrapper">
                  <Phone className="input-icon" size={18} />
                  <input
                    id="phone"
                    type="tel"
                    placeholder="+91 98765 43210"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          <div className="form-group">
            <label htmlFor="email">Work Email</label>
            <div className="input-wrapper">
              <Mail className="input-icon" size={18} />
              <input
                id="email"
                type="email"
                placeholder="founder@store.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          {mode !== "magic_link" && (
            <div className="form-group">
              <div className="form-label-row">
                <label htmlFor="password">Password</label>
                {mode === "login" && (
                  <button 
                    type="button" 
                    className="link-btn" 
                    onClick={() => { setMode("magic_link"); setErrorMsg(null); }}
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="input-wrapper">
                <Lock className="input-icon" size={18} />
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            className="submit-btn"
            disabled={loading}
          >
            {loading ? (
              <div className="spinner-sm" />
            ) : (
              <>
                <span>
                  {mode === "login" && "Sign In to Dashboard"}
                  {mode === "signup" && "Launch Merchant OS"}
                  {mode === "magic_link" && "Send Magic Link"}
                </span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>

        {/* Security Footer */}
        <div className="auth-footer">
          <ShieldCheck size={14} className="security-icon" />
          <span>Secured by Supabase Auth with PostgreSQL Row Level Security</span>
        </div>
      </div>
    </div>
  );
};
