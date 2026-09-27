"use client";

import { useMemo } from "react";
import { qrMatrix, qrPath } from "@/lib/qr";

const QUIET_ZONE = 4;

// Rendered as an SVG path built from the module matrix — no innerHTML, and the
// payload is encoded on-device.
export function QrCode({
  value,
  label,
  size = 208,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { path, extent } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { path: qrPath(matrix, QUIET_ZONE), extent: matrix.length + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="receive-qr"
      data-qr-payload={value}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="block rounded-md"
    >
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
