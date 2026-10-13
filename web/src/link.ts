/**
 * A direct connection between the two players' pages (a WebRTC data channel), set up without
 * a game server: the inviting page makes an invitation code, the joining page answers it with
 * a reply code, and the players pass the codes to each other (by email, a chat, a phone call).
 *
 * A public STUN server tells each browser how it is seen from the internet, which is how two
 * home networks find a way to each other; no game data goes through it. Networks that allow
 * no direct path (some office and mobile networks) cannot connect this way.
 */

/** The STUN servers asked; none is needed on one local network. */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** How long to wait for the browser to find its addresses before making a code. */
const GATHER_MS = 5000;

const INVITATION = "SCI1";
const REPLY = "SCR1";

/** A code that cannot be used: wrong kind, mistyped or cut short. */
export class CodeError extends Error {}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A session description as a code: the kind's prefix, a dash, the compressed SDP. */
async function encode(kind: string, sdp: string): Promise<string> {
  return `${kind}-${base64url(await deflate(sdp))}`;
}

/** The SDP in a code of the given kind; whitespace (from line breaks in a message) is ignored. */
async function decode(kind: string, code: string): Promise<string> {
  const text = code.replace(/\s+/g, "");
  const other = kind === INVITATION ? REPLY : INVITATION;
  if (text.startsWith(`${other}-`)) {
    throw new CodeError(kind === INVITATION ? "That is a reply code, not an invitation code." : "That is an invitation code, not a reply code.");
  }
  if (!text.startsWith(`${kind}-`)) throw new CodeError("That is not a Strategic Conquest code.");
  try {
    const sdp = await inflate(unbase64url(text.slice(kind.length + 1)));
    if (!sdp.startsWith("v=0")) throw new Error("not an SDP");
    return sdp;
  } catch {
    throw new CodeError("The code is incomplete or mistyped.");
  }
}

/** Resolves when the connection has gathered its addresses, or after GATHER_MS. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, GATHER_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      resolve();
    });
  });
}

export class Link {
  /** Called with each message from the other page. */
  onMessage: (data: Uint8Array) => void = () => {};
  /** Called once when the connection is lost or closed. */
  onClose: () => void = () => {};
  /** Resolves when the two pages are connected; rejects if they cannot connect. */
  readonly ready: Promise<void>;

  private readonly pc: RTCPeerConnection;
  private readonly channel: RTCDataChannel;
  private closed = false;
  private failed: () => void = () => {};

  private constructor(iceServers: RTCIceServer[]) {
    this.pc = new RTCPeerConnection({ iceServers });
    // Both pages open the same pre-agreed channel, so neither waits to be offered one.
    this.channel = this.pc.createDataChannel("game", { negotiated: true, id: 0, ordered: true });
    this.channel.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.channel.addEventListener("open", () => resolve(), { once: true });
      this.failed = () => reject(new Error("The two games could not connect."));
    });
    this.ready.catch(() => {});
    this.channel.addEventListener("message", (e: MessageEvent) => {
      const data = e.data;
      this.onMessage(data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(String(data)));
    });
    this.channel.addEventListener("close", () => this.lost());
    this.pc.addEventListener("connectionstatechange", () => {
      if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") this.lost();
    });
  }

  /** Start a connection as the inviting player: the invitation code for the other player. */
  static async invite(iceServers = ICE_SERVERS): Promise<{ link: Link; code: string }> {
    const link = new Link(iceServers);
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await gathered(link.pc);
    return { link, code: await encode(INVITATION, link.pc.localDescription!.sdp) };
  }

  /** Join with an invitation code: the reply code for the inviting player. */
  static async join(code: string, iceServers = ICE_SERVERS): Promise<{ link: Link; reply: string }> {
    const sdp = await decode(INVITATION, code);
    const link = new Link(iceServers);
    await link.pc.setRemoteDescription({ type: "offer", sdp });
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    await gathered(link.pc);
    return { link, reply: await encode(REPLY, link.pc.localDescription!.sdp) };
  }

  /** Complete an invitation with the other player's reply code. */
  async accept(reply: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp: await decode(REPLY, reply) });
  }

  send(data: Uint8Array): void {
    if (this.channel.readyState === "open") this.channel.send(data as Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.channel.close();
    this.pc.close();
    this.lost();
  }

  private lost(): void {
    if (this.closed) return;
    this.closed = true;
    this.failed();
    this.onClose();
  }
}
