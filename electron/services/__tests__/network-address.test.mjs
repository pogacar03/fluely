import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, "../../../dist-electron/electron/services/network-address.js");
let networkAddress;
try {
  networkAddress = await import(pathToFileURL(modulePath).href);
} catch {
  networkAddress = {};
}

test("private IPv4 selection rejects loopback, link-local, public, and non-IPv4 addresses", () => {
  assert.equal(typeof networkAddress.isPrivateIpv4, "function");
  for (const address of [
    "10.0.0.4",
    "172.16.4.9",
    "172.31.255.254",
    "192.168.1.20",
    "100.64.0.1",
    "100.119.160.60",
    "100.127.255.254",
  ]) {
    assert.equal(networkAddress.isPrivateIpv4(address), true, address);
  }
  for (const address of [
    "100.128.0.1",
    "127.0.0.1",
    "169.254.10.4",
    "172.32.0.1",
    "192.0.2.10",
    "8.8.8.8",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
  ]) {
    assert.equal(networkAddress.isPrivateIpv4(address), false, address);
  }
});

test("LAN address selection accepts both IPv4 family spellings and rejects both IPv6 spellings", () => {
  assert.equal(typeof networkAddress.selectPrivateIpv4, "function");
  for (const family of ["IPv4", 4]) {
    assert.equal(networkAddress.selectPrivateIpv4({
      en0: [{ address: "100.119.160.60", family, internal: false }],
    }), "100.119.160.60", String(family));
  }
  for (const family of ["IPv6", 6]) {
    assert.equal(networkAddress.selectPrivateIpv4({
      en0: [{ address: "100.119.160.60", family, internal: false }],
    }), null, String(family));
  }
});

test("RFC1918 addresses win over RFC6598 shared addresses", () => {
  assert.equal(networkAddress.selectPrivateIpv4({
    en0: [{ address: "100.119.160.60", family: "IPv4", internal: false }],
    en1: [{ address: "192.168.50.8", family: "IPv4", internal: false }],
  }), "192.168.50.8");
});

test("RFC6598 selection ignores obvious virtual and point-to-point interfaces", () => {
  assert.equal(networkAddress.selectPrivateIpv4({
    docker0: [{ address: "100.64.0.20", family: "IPv4", internal: false }],
    en0: [{ address: "100.119.160.60", family: "IPv4", internal: false }],
  }), "100.119.160.60");

  for (const name of [
    "utun0",
    "tun0",
    "tap0",
    "tailscale0",
    "docker0",
    "vmnet8",
    "bridge100",
    "awdl0",
    "llw0",
    "p2p0",
    "ppp0",
    "wg0",
    "veth123",
  ]) {
    assert.equal(networkAddress.selectPrivateIpv4({
      [name]: [{ address: "100.119.160.60", family: "IPv4", internal: false }],
    }), null, name);
  }
});

test("private IPv4 validation requires four canonical decimal octets without leading zeros", () => {
  assert.equal(typeof networkAddress.isPrivateIpv4, "function");
  for (const address of [
    "010.8.8.8",
    "10.08.8.8",
    "+10.8.8.8",
    "-10.8.8.8",
    " 10.8.8.8",
    "10.8.8.8 ",
    "0x0a.8.8.8",
    "10.8.8",
    "10.8.8.8.1",
  ]) {
    assert.equal(networkAddress.isPrivateIpv4(address), false, address);
  }

  assert.equal(networkAddress.selectPrivateIpv4({
    en0: [{ address: "010.8.8.8", family: "IPv4", internal: false }],
    en1: [{ address: "10.8.8.8", family: "IPv4", internal: false }],
  }), "10.8.8.8");
});

test("private IPv4 selection ignores internal and public interfaces without public fallback", () => {
  assert.equal(typeof networkAddress.selectPrivateIpv4, "function");
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "203.0.113.10", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    en1: [{ address: "192.168.50.8", family: "IPv4", internal: false }],
  };
  assert.equal(networkAddress.selectPrivateIpv4(interfaces), "192.168.50.8");
  assert.equal(networkAddress.selectPrivateIpv4({
    en0: [{ address: "198.51.100.7", family: "IPv4", internal: false }],
  }), null);
});
