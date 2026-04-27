// hooks/useMachineStatus.js
import { useState, useEffect } from "react";
import { API_BASE } from "../constants";

export function useMachineStatus() {
  const [machineId, setMachineId] = useState("");
  const [machineStatus, setMachineStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Read machine ID from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const machine = params.get("machine");
    if (machine) {
      setMachineId(machine);
      fetchStatus(machine);
      const interval = setInterval(() => fetchStatus(machine), 30000);
      return () => clearInterval(interval);
    } else {
      setError("Invalid kiosk link. Machine not specified.");
    }
  }, []);

  const fetchStatus = async (id) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/machines/${id}/status`);
      const data = await res.json();
      if (res.ok) {
        setMachineStatus(data);
      } else {
        setError(data.error || "Could not fetch machine status.");
      }
    } catch {
      setError("Network error while fetching machine status.");
    } finally {
      setLoading(false);
    }
  };

  const refreshStatus = () => {
    if (machineId) fetchStatus(machineId);
  };

  return {
    machineId,
    machineStatus,
    loading,
    error,
    isLocked: machineStatus?.is_print_locked ?? false,
    isOnline: !!machineStatus && !machineStatus?.is_print_locked,
    refreshStatus,
  };
}