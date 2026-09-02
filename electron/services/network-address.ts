export interface NetworkInterfaceCandidate {
  address: string;
  family: "IPv4" | "IPv6" | 4 | 6 | string | number;
  internal?: boolean;
}

export type NetworkInterfacesSnapshot = Record<string, readonly NetworkInterfaceCandidate[] | null | undefined>;

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

/** Returns true only for RFC1918 IPv4 addresses, never for public or special-use ranges. */
export function isPrivateIpv4(address: string): boolean {
  const parsed = parseIpv4(address);
  if (!parsed) {
    return false;
  }

  const [first, second] = parsed;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isIpv4Family(family: NetworkInterfaceCandidate["family"]): boolean {
  return family === "IPv4" || family === 4;
}

/** Selects a deterministic private address and deliberately has no public-address fallback. */
export function selectPrivateIpv4(
  interfaces: NetworkInterfacesSnapshot,
): string | null {
  for (const name of Object.keys(interfaces).sort()) {
    const candidates = interfaces[name] ?? [];
    for (const candidate of candidates) {
      if (!candidate || candidate.internal || !isIpv4Family(candidate.family)) {
        continue;
      }
      if (isPrivateIpv4(candidate.address)) {
        return candidate.address;
      }
    }
  }

  return null;
}
