export interface NetworkInterfaceCandidate {
  address: string;
  family: "IPv4" | "IPv6" | 4 | 6 | string | number;
  internal?: boolean;
}

export type NetworkInterfacesSnapshot = Record<string, readonly NetworkInterfaceCandidate[] | null | undefined>;

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) {
    return null;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

export function canonicalizeIpv4(address: string): string | null {
  const parsed = parseIpv4(address);
  return parsed ? parsed.join(".") : null;
}

function isRfc1918Ipv4(parsed: readonly [number, number, number, number]): boolean {
  const [first, second] = parsed;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

/** Returns true for RFC1918 private or RFC6598 shared IPv4 addresses only. */
export function isPrivateIpv4(address: string): boolean {
  const parsed = parseIpv4(address);
  if (!parsed) {
    return false;
  }

  const [first, second] = parsed;
  return isRfc1918Ipv4(parsed) || (first === 100 && second >= 64 && second <= 127);
}

/** Returns true only for RFC6598 shared IPv4 addresses in 100.64.0.0/10. */
export function isSharedIpv4(address: string): boolean {
  const parsed = parseIpv4(address);
  return parsed !== null && parsed[0] === 100 && parsed[1] >= 64 && parsed[1] <= 127;
}

function isIpv4Family(family: NetworkInterfaceCandidate["family"]): boolean {
  return family === "IPv4" || family === 4;
}

function isObviousVirtualInterface(name: string): boolean {
  return /^(?:utun|tun|tap|tailscale|docker|vmnet|bridge|awdl|llw|p2p|ppp|wg|veth|br-|virbr|vboxnet|podman|cni|flannel)(?:\d|[-_.]|$)/i.test(name);
}

function selectCandidates(
  interfaces: NetworkInterfacesSnapshot,
  predicate: (address: string) => boolean,
): string[] {
  const selected: string[] = [];
  for (const name of Object.keys(interfaces).sort()) {
    if (isObviousVirtualInterface(name)) {
      continue;
    }
    const candidates = interfaces[name] ?? [];
    for (const candidate of candidates) {
      if (!candidate || candidate.internal || !isIpv4Family(candidate.family)) {
        continue;
      }
      const canonical = canonicalizeIpv4(candidate.address);
      if (canonical && predicate(canonical) && !selected.includes(canonical)) {
        selected.push(canonical);
      }
    }
  }
  return selected;
}

/** Selects all physical RFC1918 candidates first, then physical RFC6598 candidates. */
export function selectPrivateIpv4Candidates(
  interfaces: NetworkInterfacesSnapshot,
): string[] {
  const rfc1918 = selectCandidates(interfaces, (address) => {
    const parsed = parseIpv4(address);
    return parsed !== null && isRfc1918Ipv4(parsed);
  });
  return [
    ...rfc1918,
    ...selectCandidates(interfaces, isSharedIpv4).filter((address) => !rfc1918.includes(address)),
  ];
}

/** Selects the highest-priority physical RFC1918/RFC6598 address. */
export function selectPrivateIpv4(
  interfaces: NetworkInterfacesSnapshot,
): string | null {
  return selectPrivateIpv4Candidates(interfaces)[0] ?? null;
}
