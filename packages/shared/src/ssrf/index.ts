import net from "node:net";
import dns from "node:dns/promises";

export type SsrfBlockReason =
  | "INVALID_URL"
  | "URL_TOO_LONG"
  | "INVALID_SCHEME"
  | "EMBEDDED_CREDENTIALS"
  | "INVALID_HOSTNAME"
  | "INVALID_IP"
  | "DISALLOWED_PORT"
  | "DISALLOWED_IP"
  | "DNS_RESOLUTION_FAILED"
  | "DNS_RESOLUTION_TIMEOUT"
  | "EMPTY_DNS_RESOLUTION";

export interface AddressValidationResult {
  allowed: boolean;
  reason?: SsrfBlockReason;
  message?: string;
  ip?: string;
}

export interface ValidateUrlOptions {
  allowHttp?: boolean;
  allowPrivateTargets?: boolean;
  dnsTimeoutMs?: number;
  maxUrlLength?: number;
  dnsResolver?: (hostname: string) => Promise<string[]>;
}

export type UrlValidationResult =
  | {
      isValid: true;
      url: string;
      hostname: string;
      resolvedIps: string[];
    }
  | {
      isValid: false;
      reason: SsrfBlockReason;
      message: string;
    };

// ============================================================================
// Blocked Ports & Ranges
// ============================================================================

export const SENSITIVE_BLOCKED_PORTS = new Set<number>([
  20, 21,       // FTP
  22,           // SSH
  23,           // Telnet
  25, 465, 587, // SMTP
  53,           // DNS
  67, 68,       // DHCP
  69,           // TFTP
  110, 995,     // POP3
  111,          // RPCbind
  123,          // NTP
  135, 137, 138, 139, 445, // NetBIOS / SMB
  143, 993,     // IMAP
  389, 636,     // LDAP
  2049,         // NFS
  2375, 2376,   // Docker daemon
  3306,         // MySQL
  5432,         // PostgreSQL
  5672, 15672,  // RabbitMQ
  6379, 16379, 26379, // Redis
  8500,         // Consul
  9200, 9300,   // Elasticsearch
  10250, 10255, // Kubelet
  11211,        // Memcached
  27017, 27018, 27019, // MongoDB
]);

// Full IANA Special-Purpose IPv4 Registry
export const IPV4_BLOCKLIST = new net.BlockList();
IPV4_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");       // This host on this network (RFC 1122)
IPV4_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");      // Private-Use (RFC 1918)
IPV4_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4");   // Shared Address Space / CGNAT (RFC 6598)
IPV4_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");     // Loopback (RFC 1122)
IPV4_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4");  // Link Local (RFC 3927) - includes 169.254.169.254
IPV4_BLOCKLIST.addAddress("168.63.129.16", "ipv4");   // Azure wire server / health probe IP
IPV4_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");   // Private-Use (RFC 1918)
IPV4_BLOCKLIST.addSubnet("192.0.0.0", 24, "ipv4");    // IETF Protocol Assignments (RFC 6890)
IPV4_BLOCKLIST.addSubnet("192.0.2.0", 24, "ipv4");    // Documentation TEST-NET-1 (RFC 5737)
IPV4_BLOCKLIST.addSubnet("192.31.196.0", 24, "ipv4"); // AS112-v4 (RFC 7535)
IPV4_BLOCKLIST.addSubnet("192.52.193.0", 24, "ipv4"); // AMT (RFC 7450)
IPV4_BLOCKLIST.addSubnet("192.88.99.0", 24, "ipv4");  // 6to4 Relay Anycast (RFC 7526)
IPV4_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");  // Private-Use (RFC 1918)
IPV4_BLOCKLIST.addSubnet("192.175.48.0", 24, "ipv4"); // Direct Delegation AS112 (RFC 7534)
IPV4_BLOCKLIST.addSubnet("198.18.0.0", 15, "ipv4");   // Benchmarking (RFC 2544)
IPV4_BLOCKLIST.addSubnet("198.51.100.0", 24, "ipv4"); // Documentation TEST-NET-2 (RFC 5737)
IPV4_BLOCKLIST.addSubnet("203.0.113.0", 24, "ipv4");  // Documentation TEST-NET-3 (RFC 5737)
IPV4_BLOCKLIST.addSubnet("224.0.0.0", 4, "ipv4");     // Multicast (RFC 5771)
IPV4_BLOCKLIST.addSubnet("240.0.0.0", 4, "ipv4");     // Reserved for Future Use / Broadcast (RFC 1112)

// IPv6 Default-Deny: Only allow Global Unicast 2000::/3
export const IPV6_GLOBAL_UNICAST = new net.BlockList();
IPV6_GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

// IPv6 Special-Purpose / Blocked Ranges
export const IPV6_SPECIAL_PURPOSE = new net.BlockList();
IPV6_SPECIAL_PURPOSE.addSubnet("::", 128, "ipv6");         // Unspecified
IPV6_SPECIAL_PURPOSE.addSubnet("::1", 128, "ipv6");        // Loopback
IPV6_SPECIAL_PURPOSE.addSubnet("::", 96, "ipv6");          // IPv4-compatible (deprecated)
IPV6_SPECIAL_PURPOSE.addSubnet("::ffff:0:0", 96, "ipv6");  // IPv4-mapped
IPV6_SPECIAL_PURPOSE.addSubnet("64:ff9b::", 96, "ipv6");   // IPv4/IPv6 translation
IPV6_SPECIAL_PURPOSE.addSubnet("64:ff9b:1::", 48, "ipv6"); // Local-Use IPv4/IPv6 translation
IPV6_SPECIAL_PURPOSE.addSubnet("100::", 64, "ipv6");       // Discard-Only (RFC 6666)
IPV6_SPECIAL_PURPOSE.addSubnet("2001::", 23, "ipv6");      // IETF Protocol Assignments (includes Teredo 2001::/32, Benchmarking 2001:2::/48)
IPV6_SPECIAL_PURPOSE.addSubnet("2001:db8::", 32, "ipv6");  // Documentation (RFC 3849)
IPV6_SPECIAL_PURPOSE.addSubnet("2002::", 16, "ipv6");      // 6to4 relay (RFC 3056)
IPV6_SPECIAL_PURPOSE.addSubnet("fc00::", 7, "ipv6");       // Unique-Local (ULA, RFC 4193)
IPV6_SPECIAL_PURPOSE.addSubnet("fe80::", 10, "ipv6");      // Link-Local Unicast (RFC 4291)
IPV6_SPECIAL_PURPOSE.addSubnet("fec0::", 10, "ipv6");      // Site-Local (deprecated RFC 3879)
IPV6_SPECIAL_PURPOSE.addSubnet("ff00::", 8, "ipv6");       // Multicast (RFC 4291)

// ============================================================================
// Address Validation Primitive
// ============================================================================

/**
 * Checks whether an IP address is a valid, publicly routable IP.
 * Accepts ONLY canonical IP literals; rejects zone IDs (%en0), non-canonical formats,
 * and empty strings.
 */
export function isAddressAllowed(ip: string): AddressValidationResult {
  if (!ip || typeof ip !== "string" || ip.includes("%")) {
    return { allowed: false, reason: "INVALID_IP", message: "Invalid IP address" };
  }

  const ipVersion = net.isIP(ip);
  if (ipVersion !== 4 && ipVersion !== 6) {
    return { allowed: false, reason: "INVALID_IP", message: "Invalid IP address" };
  }

  // IPv4 Canonical Literal Validation
  if (ipVersion === 4) {
    const octets = ip.split(".");
    if (octets.length !== 4) {
      return { allowed: false, reason: "INVALID_IP", message: "Invalid IPv4 address" };
    }
    for (const octet of octets) {
      if (octet.length > 1 && octet.startsWith("0")) {
        return { allowed: false, reason: "INVALID_IP", message: "Non-canonical IPv4 octet" };
      }
      const num = Number(octet);
      if (isNaN(num) || num < 0 || num > 255) {
        return { allowed: false, reason: "INVALID_IP", message: "Invalid IPv4 octet" };
      }
    }

    if (IPV4_BLOCKLIST.check(ip, "ipv4")) {
      return { allowed: false, reason: "DISALLOWED_IP", message: "Disallowed private/reserved IP", ip };
    }

    return { allowed: true, ip };
  }

  // IPv6 Validation (Default-Deny Model)
  // 1. Check for IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedMatch && mappedMatch[1]) {
    const underlyingIpv4 = mappedMatch[1];
    const ipv4Check = isAddressAllowed(underlyingIpv4);
    if (!ipv4Check.allowed) {
      return { allowed: false, reason: "DISALLOWED_IP", message: "Disallowed IPv4-mapped IPv6", ip };
    }
  }

  // Check IPv6 special purpose blocklist
  if (IPV6_SPECIAL_PURPOSE.check(ip, "ipv6")) {
    return { allowed: false, reason: "DISALLOWED_IP", message: "Disallowed IPv6 address", ip };
  }

  // Enforce Default-Deny: Must be within Global Unicast 2000::/3
  if (!IPV6_GLOBAL_UNICAST.check(ip, "ipv6")) {
    return { allowed: false, reason: "DISALLOWED_IP", message: "IPv6 address outside 2000::/3", ip };
  }

  return { allowed: true, ip };
}

// ============================================================================
// Endpoint URL Validation (Advisory Registration-Time Check)
// ============================================================================

/**
 * Pre-DNS check for blocked domain names.
 */
function isBlockedHostname(rawHostname: string): boolean {
  // Strip optional trailing dot
  const host = rawHostname.toLowerCase().replace(/\.$/, "");

  // Single-label hostnames without any dot (e.g. localhost, intranet, redis, metadata)
  if (!host.includes(".")) {
    return true;
  }

  // Special-use local/internal domains
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".lan") ||
    host.endsWith(".corp") ||
    host.endsWith(".home")
  ) {
    return true;
  }

  return false;
}

/**
 * Validates an endpoint webhook URL for safety.
 *
 * NOTE: Registration-time validation is ADVISORY ONLY because DNS records can change later
 * (DNS Rebinding attacks). Day 4's HTTP delivery worker MUST re-validate the target IP
 * at connection time using `isAddressAllowed`.
 */
export async function validateEndpointUrl(
  urlString: string,
  options?: ValidateUrlOptions,
): Promise<UrlValidationResult> {
  const allowHttp = options?.allowHttp ?? false;
  const allowPrivateTargets = options?.allowPrivateTargets ?? false;
  const maxUrlLength = options?.maxUrlLength ?? 2048;
  const dnsTimeoutMs = options?.dnsTimeoutMs ?? 2000;

  // 1. Length validation
  if (typeof urlString !== "string" || urlString.length > maxUrlLength) {
    return {
      isValid: false,
      reason: "URL_TOO_LONG",
      message: "URL not permitted",
    };
  }

  // 2. Syntax parsing via WHATWG URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return {
      isValid: false,
      reason: "INVALID_URL",
      message: "URL not permitted",
    };
  }

  // 3. Scheme check
  const scheme = parsedUrl.protocol;
  if (scheme !== "https:" && (scheme !== "http:" || !allowHttp)) {
    return {
      isValid: false,
      reason: "INVALID_SCHEME",
      message: "URL not permitted",
    };
  }

  // 4. Embedded credentials check
  // Note: WHATWG URL parser converts '\' to '/' for special schemes like https:,
  // which masks userinfo tricks like "https://example.com\@127.0.0.1/" where RFC 3986
  // parsers treat "example.com\" as userinfo and "127.0.0.1" as host.
  // We inspect the raw authority segment before normalization.
  const rawAuthority = urlString.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split(/[/?#]/)[0] ?? "";
  if (rawAuthority.includes("\\") || rawAuthority.includes("@") || parsedUrl.username || parsedUrl.password) {
    return {
      isValid: false,
      reason: "EMBEDDED_CREDENTIALS",
      message: "URL not permitted",
    };
  }

  // 5. Hostname presence
  if (!parsedUrl.hostname) {
    return {
      isValid: false,
      reason: "INVALID_HOSTNAME",
      message: "URL not permitted",
    };
  }

  // 6. Sensitive port check
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === "https:"
      ? 443
      : 80;

  if (isNaN(port) || port <= 0 || port > 65535 || SENSITIVE_BLOCKED_PORTS.has(port)) {
    return {
      isValid: false,
      reason: "DISALLOWED_PORT",
      message: "URL not permitted",
    };
  }

  // Extract clean hostname without IPv6 brackets
  const cleanHost = parsedUrl.hostname.replace(/^\[|\]$/g, "");

  // 7. Check if hostname is an IP literal
  const ipVersion = net.isIP(cleanHost);
  if (ipVersion !== 0) {
    if (allowPrivateTargets) {
      return {
        isValid: true,
        url: parsedUrl.href,
        hostname: parsedUrl.hostname,
        resolvedIps: [cleanHost],
      };
    }

    const ipCheck = isAddressAllowed(cleanHost);
    if (!ipCheck.allowed) {
      return {
        isValid: false,
        reason: "DISALLOWED_IP",
        message: "URL not permitted",
      };
    }

    return {
      isValid: true,
      url: parsedUrl.href,
      hostname: parsedUrl.hostname,
      resolvedIps: [cleanHost],
    };
  }

  // 8. Pre-DNS Hostname checks (blocking localhost, *.local, single-label names)
  if (!allowPrivateTargets && isBlockedHostname(cleanHost)) {
    return {
      isValid: false,
      reason: "INVALID_HOSTNAME",
      message: "URL not permitted",
    };
  }

  // 9. DNS Resolution (with timeout and checking EVERY returned address)
  let resolvedIps: string[];

  try {
    if (options?.dnsResolver) {
      resolvedIps = await options.dnsResolver(cleanHost);
    } else {
      // dns.promises.lookup with verbatim: true matches standard connect resolution
      // Note: Promise.race does not cancel the underlying OS getaddrinfo worker thread
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error("DNS_TIMEOUT"));
        }, dnsTimeoutMs);
      });

      try {
        const lookupPromise = dns.lookup(cleanHost, { all: true, verbatim: true });
        const records = await Promise.race([lookupPromise, timeoutPromise]);
        resolvedIps = records.map((r) => r.address);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.message === "DNS_TIMEOUT") {
      return {
        isValid: false,
        reason: "DNS_RESOLUTION_TIMEOUT",
        message: "URL not permitted",
      };
    }
    return {
      isValid: false,
      reason: "DNS_RESOLUTION_FAILED",
      message: "URL not permitted",
    };
  }

  if (!resolvedIps || resolvedIps.length === 0) {
    return {
      isValid: false,
      reason: "EMPTY_DNS_RESOLUTION",
      message: "URL not permitted",
    };
  }

  // 10. Check EVERY resolved address
  if (!allowPrivateTargets) {
    for (const address of resolvedIps) {
      const addressCheck = isAddressAllowed(address);
      if (!addressCheck.allowed) {
        return {
          isValid: false,
          reason: "DISALLOWED_IP",
          message: "URL not permitted",
        };
      }
    }
  }

  return {
    isValid: true,
    url: parsedUrl.href,
    hostname: parsedUrl.hostname,
    resolvedIps,
  };
}
