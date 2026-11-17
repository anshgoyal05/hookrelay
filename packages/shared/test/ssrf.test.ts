import { describe, it, expect } from "vitest";
import net from "node:net";
import {
  isAddressAllowed,
  validateEndpointUrl,
  IPV4_BLOCKLIST,
} from "../src/ssrf/index.js";

describe("packages/shared - SSRF URL Safety & Address Validation", () => {
  describe("1. isAddressAllowed - Canonical IP Literal & Boundary Tests", () => {
    // Range Boundary Table
    const boundaryCases: Array<{ ip: string; expectedAllowed: boolean; description: string }> = [
      // 172.16.0.0/12 boundaries
      { ip: "172.15.255.255", expectedAllowed: true, description: "RFC 1918 172.16 lower boundary - 1" },
      { ip: "172.16.0.0", expectedAllowed: false, description: "RFC 1918 172.16 lower boundary" },
      { ip: "172.31.255.255", expectedAllowed: false, description: "RFC 1918 172.16 upper boundary" },
      { ip: "172.32.0.0", expectedAllowed: true, description: "RFC 1918 172.16 upper boundary + 1" },

      // 100.64.0.0/10 CGNAT boundaries
      { ip: "100.63.255.255", expectedAllowed: true, description: "CGNAT lower boundary - 1" },
      { ip: "100.64.0.0", expectedAllowed: false, description: "CGNAT lower boundary" },
      { ip: "100.127.255.255", expectedAllowed: false, description: "CGNAT upper boundary" },
      { ip: "100.128.0.0", expectedAllowed: true, description: "CGNAT upper boundary + 1" },

      // 169.254.0.0/16 Link-Local boundaries
      { ip: "169.253.255.255", expectedAllowed: true, description: "Link-Local lower boundary - 1" },
      { ip: "169.254.0.0", expectedAllowed: false, description: "Link-Local lower boundary" },
      { ip: "169.254.169.254", expectedAllowed: false, description: "Cloud metadata address" },
      { ip: "169.254.255.255", expectedAllowed: false, description: "Link-Local upper boundary" },
      { ip: "169.255.0.0", expectedAllowed: true, description: "Link-Local upper boundary + 1" },

      // 198.18.0.0/15 Benchmarking boundaries
      { ip: "198.17.255.255", expectedAllowed: true, description: "Benchmarking lower boundary - 1" },
      { ip: "198.18.0.0", expectedAllowed: false, description: "Benchmarking lower boundary" },
      { ip: "198.19.255.255", expectedAllowed: false, description: "Benchmarking upper boundary" },
      { ip: "198.20.0.0", expectedAllowed: true, description: "Benchmarking upper boundary + 1" },

      // Specific Azure Wire Server
      { ip: "168.63.129.16", expectedAllowed: false, description: "Azure wire server IP" },

      // Public Unicast IPs
      { ip: "8.8.8.8", expectedAllowed: true, description: "Google Public DNS" },
      { ip: "1.1.1.1", expectedAllowed: true, description: "Cloudflare Public DNS" },
      { ip: "93.184.216.34", expectedAllowed: true, description: "example.com public IP" },

      // Other IANA IPv4 Special-Purpose
      { ip: "0.0.0.0", expectedAllowed: false, description: "0.0.0.0/8 source" },
      { ip: "127.0.0.1", expectedAllowed: false, description: "IPv4 loopback" },
      { ip: "127.255.255.255", expectedAllowed: false, description: "IPv4 loopback broadcast" },
      { ip: "10.0.0.1", expectedAllowed: false, description: "10.0.0.0/8 private" },
      { ip: "192.168.1.1", expectedAllowed: false, description: "192.168.0.0/16 private" },
      { ip: "192.0.2.1", expectedAllowed: false, description: "TEST-NET-1" },
      { ip: "192.88.99.1", expectedAllowed: false, description: "6to4 relay anycast" },
      { ip: "192.31.196.1", expectedAllowed: false, description: "AS112-v4" },
      { ip: "192.52.193.1", expectedAllowed: false, description: "AMT" },
      { ip: "192.175.48.1", expectedAllowed: false, description: "Direct Delegation AS112" },
      { ip: "198.51.100.1", expectedAllowed: false, description: "TEST-NET-2" },
      { ip: "203.0.113.1", expectedAllowed: false, description: "TEST-NET-3" },
      { ip: "224.0.0.1", expectedAllowed: false, description: "Multicast" },
      { ip: "255.255.255.255", expectedAllowed: false, description: "Limited broadcast" },

      // IPv6 Global Unicast vs Disallowed
      { ip: "2606:4700:4700::1111", expectedAllowed: true, description: "Cloudflare IPv6 (in 2000::/3)" },
      { ip: "2001:4860:4860::8888", expectedAllowed: true, description: "Google IPv6 (in 2000::/3)" },
      { ip: "::1", expectedAllowed: false, description: "IPv6 loopback" },
      { ip: "::", expectedAllowed: false, description: "IPv6 unspecified" },
      { ip: "fc00::1", expectedAllowed: false, description: "IPv6 ULA" },
      { ip: "fd12:3456:789a::1", expectedAllowed: false, description: "IPv6 ULA fd00::" },
      { ip: "fe80::1", expectedAllowed: false, description: "IPv6 Link-Local" },
      { ip: "ff02::1", expectedAllowed: false, description: "IPv6 Multicast" },
      { ip: "2002:7f00:1::", expectedAllowed: false, description: "6to4 relay prefix 2002::/16" },
      { ip: "2001:0000:4136:e378:8000:63bf:3fff:fdd2", expectedAllowed: false, description: "Teredo prefix 2001::/32" },
      { ip: "2001:db8::1", expectedAllowed: false, description: "Documentation 2001:db8::/32" },
      { ip: "::ffff:127.0.0.1", expectedAllowed: false, description: "IPv4-mapped loopback" },
      { ip: "::ffff:10.0.0.1", expectedAllowed: false, description: "IPv4-mapped private 10.0.0.1" },
      { ip: "::ffff:169.254.169.254", expectedAllowed: false, description: "IPv4-mapped cloud metadata" },
      { ip: "::ffff:192.168.1.1", expectedAllowed: false, description: "IPv4-mapped private 192.168.1.1" },
    ];

    for (const testCase of boundaryCases) {
      it(`${testCase.ip} (${testCase.description}) -> allowed: ${testCase.expectedAllowed}`, () => {
        const result = isAddressAllowed(testCase.ip);
        expect(result.allowed).toBe(testCase.expectedAllowed);
      });
    }
  });

  describe("2. isAddressAllowed - Junk & Non-Canonical Input", () => {
    const junkCases = [
      "",
      " ",
      "fe80::1%en0",
      "::1%eth0",
      "2130706433",
      "0177.0.0.1",
      "127.000.000.001",
      "127.1",
      "0x7f000001",
      "not-an-ip",
      "127.0.0.256",
      "256.1.1.1",
      "1.2.3.4.5",
      ":::1",
      "http://127.0.0.1",
    ];

    for (const junk of junkCases) {
      it(`rejects non-canonical/junk input: "${junk}"`, () => {
        const result = isAddressAllowed(junk);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe("INVALID_IP");
      });
    }
  });

  describe("3. BlockList Native Behavior Cross-Check", () => {
    it("proves node:net BlockList checks IPv4-mapped IPv6 addresses", () => {
      const bl = new net.BlockList();
      bl.addSubnet("127.0.0.0", 8, "ipv4");
      bl.addSubnet("10.0.0.0", 8, "ipv4");

      expect(bl.check("127.0.0.1", "ipv4")).toBe(true);
      expect(bl.check("::ffff:127.0.0.1", "ipv6")).toBe(true);
      expect(bl.check("::ffff:10.0.0.1", "ipv6")).toBe(true);
      expect(bl.check("8.8.8.8", "ipv4")).toBe(false);
      expect(bl.check("::ffff:8.8.8.8", "ipv6")).toBe(false);
    });

    it("randomized cross-check against IPV4_BLOCKLIST", () => {
      // Deterministic pseudo-random test generator
      for (let i = 0; i < 50; i++) {
        const a = (i * 37) % 256;
        const b = (i * 73) % 256;
        const c = (i * 101) % 256;
        const d = (i * 17) % 256;
        const ip = `${a}.${b}.${c}.${d}`;

        const isBlockedInList = IPV4_BLOCKLIST.check(ip, "ipv4");
        const res = isAddressAllowed(ip);
        expect(res.allowed).toBe(!isBlockedInList);
      }
    });
  });

  describe("4. validateEndpointUrl - Comprehensive Table-Driven Tests", () => {
    const urlTable = [
      // Valid URLs (using fake resolver for domains)
      {
        url: "https://example.com/webhook",
        resolver: async () => ["93.184.216.34"],
        expectedValid: true,
        desc: "Standard HTTPS domain with public IP",
      },
      {
        url: "https://8.8.8.8/events",
        expectedValid: true,
        desc: "Public IPv4 literal",
      },
      {
        url: "https://1.1.1.1:8443/webhook",
        expectedValid: true,
        desc: "Public IPv4 literal on safe custom port 8443",
      },
      {
        url: "https://[2606:4700:4700::1111]/hook",
        expectedValid: true,
        desc: "Public IPv6 literal in 2000::/3",
      },

      // Tricky IP encodings in hostnames (normalized by WHATWG parser)
      {
        url: "http://2130706433/",
        allowHttp: true,
        expectedValid: false,
        expectedReason: "DISALLOWED_IP",
        desc: "Dword/Decimal IP (normalized to 127.0.0.1)",
      },
      {
        url: "http://0x7f000001/",
        allowHttp: true,
        expectedValid: false,
        expectedReason: "DISALLOWED_IP",
        desc: "Hexadecimal IP (normalized to 127.0.0.1)",
      },
      {
        url: "http://0177.0.0.1/",
        allowHttp: true,
        expectedValid: false,
        expectedReason: "DISALLOWED_IP",
        desc: "Octal IP (normalized to 127.0.0.1)",
      },
      {
        url: "http://127.1/",
        allowHttp: true,
        expectedValid: false,
        expectedReason: "DISALLOWED_IP",
        desc: "Short-form IP (normalized to 127.0.0.1)",
      },

      // Parser credential tricks
      {
        url: "https://example.com\\@127.0.0.1/",
        expectedValid: false,
        expectedReason: "EMBEDDED_CREDENTIALS",
        desc: "Backslash userinfo trick (username: example.com, host: 127.0.0.1)",
      },
      {
        url: "https://example.com@127.0.0.1/",
        expectedValid: false,
        expectedReason: "EMBEDDED_CREDENTIALS",
        desc: "Standard userinfo trick (username: example.com, host: 127.0.0.1)",
      },
      {
        url: "https://user:password@public-api.com/webhook",
        expectedValid: false,
        expectedReason: "EMBEDDED_CREDENTIALS",
        desc: "Explicit embedded user and password",
      },

      // Scheme validation
      {
        url: "http://example.com/hook",
        allowHttp: false,
        expectedValid: false,
        expectedReason: "INVALID_SCHEME",
        desc: "HTTP rejected by default when allowHttp is false",
      },
      {
        url: "http://example.com/hook",
        allowHttp: true,
        resolver: async () => ["93.184.216.34"],
        expectedValid: true,
        desc: "HTTP allowed when allowHttp is explicitly true",
      },
      {
        url: "ftp://example.com/hook",
        expectedValid: false,
        expectedReason: "INVALID_SCHEME",
        desc: "FTP scheme rejected",
      },
      {
        url: "file:///etc/passwd",
        expectedValid: false,
        expectedReason: "INVALID_SCHEME",
        desc: "File scheme rejected",
      },
      {
        url: "gopher://127.0.0.1:70",
        expectedValid: false,
        expectedReason: "INVALID_SCHEME",
        desc: "Gopher scheme rejected",
      },
      {
        url: "javascript:alert(1)",
        expectedValid: false,
        expectedReason: "INVALID_SCHEME",
        desc: "Javascript pseudo-scheme rejected",
      },

      // Blocked Ports
      {
        url: "https://8.8.8.8:22/hook",
        expectedValid: false,
        expectedReason: "DISALLOWED_PORT",
        desc: "SSH port 22 rejected",
      },
      {
        url: "https://8.8.8.8:25/hook",
        expectedValid: false,
        expectedReason: "DISALLOWED_PORT",
        desc: "SMTP port 25 rejected",
      },
      {
        url: "https://8.8.8.8:445/hook",
        expectedValid: false,
        expectedReason: "DISALLOWED_PORT",
        desc: "SMB port 445 rejected",
      },
      {
        url: "https://8.8.8.8:5432/hook",
        expectedValid: false,
        expectedReason: "DISALLOWED_PORT",
        desc: "Postgres port 5432 rejected",
      },
      {
        url: "https://8.8.8.8:6379/hook",
        expectedValid: false,
        expectedReason: "DISALLOWED_PORT",
        desc: "Redis port 6379 rejected",
      },
      {
        url: "https://8.8.8.8:2375/hook",
        expectedValid: false,
        expectedReason: "DISALLOWED_PORT",
        desc: "Docker daemon port 2375 rejected",
      },

      // Pre-DNS Hostname Deny-List
      {
        url: "https://localhost/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "localhost rejected pre-DNS",
      },
      {
        url: "https://localhost./webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "localhost. with trailing dot rejected pre-DNS",
      },
      {
        url: "https://sub.localhost/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "*.localhost rejected pre-DNS",
      },
      {
        url: "https://myservice.local/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "*.local rejected pre-DNS",
      },
      {
        url: "https://app.internal/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "*.internal rejected pre-DNS",
      },
      {
        url: "https://db.localdomain/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "*.localdomain rejected pre-DNS",
      },
      {
        url: "https://intranet/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "Single-label hostname rejected pre-DNS",
      },
      {
        url: "https://metadata/webhook",
        expectedValid: false,
        expectedReason: "INVALID_HOSTNAME",
        desc: "Single-label hostname 'metadata' rejected pre-DNS",
      },

      // DNS Resolution Failures & Rebinding Defense
      {
        url: "https://rebinding-attack.com/webhook",
        resolver: async () => ["93.184.216.34", "127.0.0.1"],
        expectedValid: false,
        expectedReason: "DISALLOWED_IP",
        desc: "Dual DNS record with 1 public and 1 loopback IP rejected",
      },
      {
        url: "https://metadata-rebinding.com/webhook",
        resolver: async () => ["169.254.169.254"],
        expectedValid: false,
        expectedReason: "DISALLOWED_IP",
        desc: "Resolves to cloud metadata IP rejected",
      },
      {
        url: "https://empty-dns.com/webhook",
        resolver: async () => [],
        expectedValid: false,
        expectedReason: "EMPTY_DNS_RESOLUTION",
        desc: "Empty DNS record rejected",
      },
      {
        url: "https://nonexistent-domain-nxdomain.xyz/webhook",
        resolver: async () => {
          throw new Error("ENOTFOUND");
        },
        expectedValid: false,
        expectedReason: "DNS_RESOLUTION_FAILED",
        desc: "NXDOMAIN resolution error rejected",
      },
      {
        url: "https://timeout-dns.com/webhook",
        resolver: async () => {
          throw new Error("DNS_TIMEOUT");
        },
        expectedValid: false,
        expectedReason: "DNS_RESOLUTION_TIMEOUT",
        desc: "DNS timeout rejected",
      },

      // Overlong URLs
      {
        url: "https://example.com/" + "a".repeat(2050),
        expectedValid: false,
        expectedReason: "URL_TOO_LONG",
        desc: "URL exceeding 2048 characters rejected",
      },

      // Malformed URL syntax
      {
        url: "not-a-valid-url",
        expectedValid: false,
        expectedReason: "INVALID_URL",
        desc: "Malformed string rejected",
      },
      {
        url: "https://",
        expectedValid: false,
        expectedReason: "INVALID_URL",
        desc: "Empty hostname rejected",
      },
    ];

    for (const testCase of urlTable) {
      it(`${testCase.desc}: ${testCase.url}`, async () => {
        const result = await validateEndpointUrl(testCase.url, {
          allowHttp: testCase.allowHttp ?? false,
          dnsResolver: testCase.resolver,
        });

        expect(result.isValid).toBe(testCase.expectedValid);
        if (!testCase.expectedValid) {
          expect((result as { reason: string }).reason).toBe(testCase.expectedReason);
          // Client-facing messages must be generic and never leak resolved IPs
          expect((result as { message: string }).message).toBe("URL not permitted");
        } else {
          expect((result as { url: string }).url).toBeDefined();
          expect((result as { resolvedIps: string[] }).resolvedIps.length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe("5. allowPrivateTargets Flag for Local Development", () => {
    it("allows private and loopback targets when allowPrivateTargets is true", async () => {
      const resLoopback = await validateEndpointUrl("http://127.0.0.1:8080/webhook", {
        allowHttp: true,
        allowPrivateTargets: true,
      });
      expect(resLoopback.isValid).toBe(true);

      const resLocalhost = await validateEndpointUrl("http://localhost:3000/webhook", {
        allowHttp: true,
        allowPrivateTargets: true,
        dnsResolver: async () => ["127.0.0.1"],
      });
      expect(resLocalhost.isValid).toBe(true);
    });

    it("rejects private targets when allowPrivateTargets is omitted or false", async () => {
      const res = await validateEndpointUrl("http://127.0.0.1:8080/webhook", {
        allowHttp: true,
        allowPrivateTargets: false,
      });
      expect(res.isValid).toBe(false);
      expect((res as { reason: string }).reason).toBe("DISALLOWED_IP");
    });
  });
});
