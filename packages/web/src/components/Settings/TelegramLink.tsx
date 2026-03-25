import { useState, useEffect, useCallback } from "react";
import { generateOtp, getLinkStatus, unlinkTelegram } from "../../services/link";
import type { LinkStatus } from "../../services/link";
import "./TelegramLink.css";

interface Props {
  token: string;
}

const OTP_DURATION_SEC = 300;

export function TelegramLink({ token }: Props) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [otpCode, setOtpCode] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getLinkStatus(token);
      setStatus(s);
    } catch {
      setError("Failed to load link status.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Countdown timer
  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [remaining]);

  const handleGenerateOtp = async () => {
    setError(null);
    try {
      const { code } = await generateOtp(token);
      setOtpCode(code);
      setRemaining(OTP_DURATION_SEC);
    } catch {
      setError("Failed to generate OTP.");
    }
  };

  const handleUnlink = async () => {
    setError(null);
    try {
      await unlinkTelegram(token);
      setStatus({ linked: false });
      setOtpCode(null);
    } catch {
      setError("Failed to unlink.");
    }
  };

  if (loading) {
    return <div className="telegram-link">Loading...</div>;
  }

  return (
    <div className="telegram-link">
      <h3 className="telegram-link__title">Telegram Link</h3>

      {error && <p className="telegram-link__error">{error}</p>}

      {status?.linked ? (
        <div className="telegram-link__linked">
          <p>Telegram ID <strong>{status.telegramUserId}</strong> linked</p>
          <button className="telegram-link__btn telegram-link__btn--danger" onClick={handleUnlink}>
            Unlink
          </button>
        </div>
      ) : (
        <div className="telegram-link__unlinked">
          {otpCode ? (
            <div className="telegram-link__otp">
              {remaining > 0 ? (
                <>
                  <p className="telegram-link__otp-code">{otpCode}</p>
                  <p className="telegram-link__otp-guide">
                    Send <code>/link {otpCode}</code> to the Telegram bot.
                  </p>
                  <p className="telegram-link__countdown">
                    {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                  </p>
                </>
              ) : (
                <p className="telegram-link__expired">Code has expired.</p>
              )}
              <button className="telegram-link__btn" onClick={handleGenerateOtp}>
                Generate new code
              </button>
            </div>
          ) : (
            <button className="telegram-link__btn" onClick={handleGenerateOtp}>
              Link Telegram
            </button>
          )}
        </div>
      )}
    </div>
  );
}
