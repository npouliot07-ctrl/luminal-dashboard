import React, { useState } from "react";
import { Zap } from "lucide-react";

const PASSWORD = "luminal2026";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = () => {
    if (input === PASSWORD) {
      localStorage.setItem("luminal_auth", "true");
      onLogin();
    } else {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-app)" }}>
      <div style={{ width: 360, padding: 32, borderRadius: 16, background: "var(--bg-surface)", border: "1px solid var(--border-light)", boxShadow: "0 10px 40px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <Zap size={22} color="var(--accent)" />
          <h1 style={{ margin: 0, fontSize: 24 }}>Luminal</h1>
        </div>

        <p style={{ marginBottom: 16, color: "var(--text-secondary)" }}>
          Enter your password to continue
        </p>

        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          style={{ width: "100%", marginBottom: 12 }}
          autoFocus
        />

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>
            Incorrect password
          </div>
        )}

        <button className="btn btn-primary" style={{ width: "100%" }} onClick={handleSubmit}>
          Sign in
        </button>
      </div>
    </div>
  );
}
