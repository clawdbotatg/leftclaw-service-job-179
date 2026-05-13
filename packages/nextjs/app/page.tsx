"use client";

import dynamic from "next/dynamic";

const VaultDashboard = dynamic(() => import("./vault-dashboard"), { ssr: false });

export default function Page() {
  return <VaultDashboard />;
}
