import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { LiteSshError } from '../core/errors.js';

export interface WindowsObjectIdentity {
  path: string;
  dev: string;
  ino: string;
}
interface WindowsPermissionRequest {
  operation: 'verify' | 'protect' | 'directory' | 'remove' | 'boundaries';
  target: string;
  kind: 'file' | 'directory';
  expected?: WindowsObjectIdentity;
  ancestors: WindowsObjectIdentity[];
  components?: string[];
  /** Verification-only directories and link nodes used to select a credential. */
  boundaries?: Array<WindowsObjectIdentity & { link: boolean }>;
}
const run = promisify(execFile);
const HELPER_CONCURRENCY = 6;
const HELPER_QUEUE_LIMIT = 128;
let runningHelpers = 0;
const waitingHelpers: Array<() => void> = [];

async function helperSlot(): Promise<() => void> {
  if (runningHelpers >= HELPER_CONCURRENCY) {
    if (waitingHelpers.length >= HELPER_QUEUE_LIMIT) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The Windows permission helper budget has been reached.');
    }
    await new Promise<void>(resolve => waitingHelpers.push(resolve));
  } else { runningHelpers++; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingHelpers.shift();
    if (next) next(); else runningHelpers--;
  };
}

// Public Win32 handle APIs are necessary for directories; pathname Set-Acl
// cannot bind a permission change to the object acquired by the caller. The
// helper holds every existing ancestor handle (no FILE_SHARE_DELETE) until the
// operation finishes. Paths/identities are JSON data, never script fragments.
const NATIVE_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class LitePrivateSecurity {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh;
        public uint WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileIdInformation { public ulong Volume, Low, High; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int type, out FileIdInformation information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int type, ref int information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    static readonly string Sid = WindowsIdentity.GetCurrent().User.Value;
    static bool Trusted(string sid) { return sid == Sid || sid == "S-1-5-18" || sid == "S-1-5-32-544"; }
    // Windows commonly owns the OS drive root through this protected system
    // service. This is ancestor trust only, never a private-file ACL exception.
    static bool TrustedAncestor(string sid) {
        return Trusted(sid) || sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    }
    static void Check(bool valid, string code = "CHECK") { if (!valid) throw new InvalidOperationException("LSSH_" + code); }
    static string Extended(string path) {
        string slash = ((char)92).ToString();
        string prefix = slash + slash + "?" + slash;
        if (path.StartsWith(prefix, StringComparison.Ordinal)) return path;
        if (path.StartsWith(slash + slash, StringComparison.Ordinal)) return prefix + "UNC" + slash + path.Substring(2);
        return prefix + path;
    }
    static SafeFileHandle Open(string path, uint additional) {
        var handle = CreateFile(Extended(path), 0x20000u | additional, 3u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new InvalidOperationException("Private handle unavailable."); }
        return handle;
    }
    static FileIdInformation Identity(SafeFileHandle handle, bool directory, string dev, string ino, bool link = false) {
        FileInformation basic;
        Check(GetFileInformationByHandle(handle, out basic));
        Check(((basic.Attributes & 0x400u) != 0) == link);
        if (!link) Check(((basic.Attributes & 0x10u) != 0) == directory);
        FileIdInformation full;
        Check(GetFileInformationByHandleEx(handle, 18, out full, 24));
        // Node/libuv exposes volume serial + 64-bit inode. Fail closed if this
        // filesystem needs a wider ID that cannot bind the Node acquisition.
        Check(full.High == 0 && full.Low == (((ulong)basic.IndexHigh << 32) | basic.IndexLow), "FILE_ID_MAPPING");
        if (dev != null) Check(basic.Volume.ToString() == dev && full.Low.ToString() == ino, "ACQUISITION_IDENTITY");
        return full;
    }
    static RawSecurityDescriptor Descriptor(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, pointer;
        Check(GetSecurityInfo(handle, 1, 5u, out owner, out group, out dacl, out sacl, out pointer) == 0);
        try {
            uint length = GetSecurityDescriptorLength(pointer);
            Check(length > 0 && length <= 65536);
            var bytes = new byte[length];
            Marshal.Copy(pointer, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(pointer); }
    }
    static void Verify(SafeFileHandle handle, bool ancestor, bool link = false) {
        var descriptor = Descriptor(handle);
        Check(descriptor.Owner != null && (ancestor ? TrustedAncestor(descriptor.Owner.Value) : descriptor.Owner.Value == Sid), "OWNER");
        // A null DACL permits everyone. An empty DACL is private but may not
        // allow the requested I/O; do not silently broaden a user's ACL.
        Check(descriptor.DiscretionaryAcl != null);
        foreach (GenericAce ace in descriptor.DiscretionaryAcl) {
            var rule = ace as QualifiedAce;
            Check(rule != null);
            if (rule.AceQualifier != AceQualifier.AccessAllowed || (ancestor ? TrustedAncestor(rule.SecurityIdentifier.Value) : Trusted(rule.SecurityIdentifier.Value))) continue;
            if (ancestor && (rule.AceFlags & AceFlags.InheritOnly) != 0) continue;
            // AppendData alone (create subdirectory) cannot rename a protected
            // child. EEXIST winners are separately verified. Other mutations,
            // DELETE_CHILD, DELETE, WRITE_DAC and WRITE_OWNER are unsafe.
            // Reparse nodes also require AppendData/WriteEA exclusion: their
            // target can be changed in-place without replacing the directory name.
            uint mutation = link ? 0x500D0156u : 0x500D0152u;
            Check(ancestor && (((uint)rule.AccessMask & mutation) == 0), ancestor ? "ANCESTOR_MUTATION" : "PRIVATE_DACL");
        }
    }
    static byte[] PrivateDescriptor(bool directory) {
        var descriptor = new RawSecurityDescriptor("O:" + Sid + "D:P(A;" + (directory ? "OICI" : "") + ";FA;;;" + Sid + ")");
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return bytes;
    }
    static void Protect(SafeFileHandle handle, bool directory) {
        Check(Descriptor(handle).Owner.Value == Sid);
        var descriptor = new RawSecurityDescriptor(PrivateDescriptor(directory), 0);
        var bytes = new byte[descriptor.DiscretionaryAcl.BinaryLength];
        descriptor.DiscretionaryAcl.GetBinaryForm(bytes, 0);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            // DACL only: no SetOwner, WRITE_OWNER request or privilege changes.
            Check(SetSecurityInfo(handle, 1, 0x80000004u, IntPtr.Zero, IntPtr.Zero, pinned.AddrOfPinnedObject(), IntPtr.Zero) == 0);
        } finally { pinned.Free(); }
        Verify(handle, false);
    }
    public static void Apply(string target, bool directory, int operation, string dev, string ino, string[] parents, string[] devices, string[] inodes) {
        var held = new List<SafeFileHandle>();
        try {
            for (int i = 0; i < parents.Length; i++) {
                var parent = Open(parents[i], 0u); held.Add(parent);
                Identity(parent, true, devices[i], inodes[i]); Verify(parent, true);
            }
            using (var handle = Open(target, operation == 1 ? 0x40000u : operation == 2 ? 0x10000u : 0u)) {
                var before = Identity(handle, directory, dev, ino);
                if (operation == 1) Protect(handle, directory);
                else if (operation == 2) {
                    Check(Descriptor(handle).Owner.Value == Sid);
                    int delete = 1;
                    Check(SetFileInformationByHandle(handle, 4, ref delete, 4));
                } else Verify(handle, false);
                var after = Identity(handle, directory, dev, ino);
                Check(before.Volume == after.Volume && before.Low == after.Low && before.High == after.High);
            }
        } finally { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); }
    }
    public static void Boundaries(string[] names, string[] devices, string[] inodes, bool[] links) {
        var held = new List<SafeFileHandle>();
        try {
            for (int i = 0; i < names.Length; i++) {
                var handle = Open(names[i], 0u); held.Add(handle);
                Identity(handle, true, devices[i], inodes[i], links[i]);
                Verify(handle, true, links[i]);
            }
        } finally { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); }
    }
    public static void Ensure(string[] components, int existingCount, string[] devices, string[] inodes) {
        var held = new List<SafeFileHandle>();
        var bytes = PrivateDescriptor(true);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0 };
        try {
            for (int i = 0; i < components.Length; i++) {
                if (i >= existingCount && !CreateDirectory(Extended(components[i]), ref attributes)) {
                    // Never protect an EEXIST winner: it was not acquired here.
                    Check(Marshal.GetLastWin32Error() == 183);
                }
                var handle = Open(components[i], 0u); held.Add(handle);
                Identity(handle, true, i < existingCount ? devices[i] : null, i < existingCount ? inodes[i] : null);
                Verify(handle, i != components.Length - 1);
            }
        } finally {
            pinned.Free();
            for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
        }
    }
}
`;
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LSSH_NATIVE_SOURCE)))
    $r = ConvertFrom-Json -InputObject $env:LSSH_PERMISSION_REQUEST
    $parents = @($r.ancestors | ForEach-Object { [string]$_.path })
    $devices = @($r.ancestors | ForEach-Object { [string]$_.dev })
    $inodes = @($r.ancestors | ForEach-Object { [string]$_.ino })
    if ($r.operation -eq 'boundaries') {
        $names = @($r.boundaries | ForEach-Object { [string]$_.path })
        $boundaryDevices = @($r.boundaries | ForEach-Object { [string]$_.dev })
        $boundaryInodes = @($r.boundaries | ForEach-Object { [string]$_.ino })
        $links = @($r.boundaries | ForEach-Object { [bool]$_.link })
        [LitePrivateSecurity]::Boundaries([string[]]$names, [string[]]$boundaryDevices, [string[]]$boundaryInodes, [bool[]]$links)
    } elseif ($r.operation -eq 'directory') {
        [LitePrivateSecurity]::Ensure([string[]]$r.components, $parents.Length, [string[]]$devices, [string[]]$inodes)
    } else {
        $operation = if ($r.operation -eq 'protect') { 1 } elseif ($r.operation -eq 'remove') { 2 } else { 0 }
        [LitePrivateSecurity]::Apply([string]$r.target, $r.kind -eq 'directory', $operation, [string]$r.expected.dev, [string]$r.expected.ino, [string[]]$parents, [string[]]$devices, [string[]]$inodes)
    }
} catch {
    $code = $_.Exception.GetBaseException().Message
    if ($code -notmatch '^LSSH_[A-Z_]+$') { $code = 'LSSH_NATIVE_INVOCATION' }
    [Console]::Error.WriteLine($code)
    exit 1
}
`;

/** No dependencies installed, no user module profiles, no stdout diagnostics. */
export async function windowsPermissions(request: WindowsPermissionRequest): Promise<void> {
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const release = await helperSlot();
  try {
    await run(executable, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(SCRIPT, 'utf16le').toString('base64')
  ], {
    windowsHide: true, timeout: 15_000, maxBuffer: 8192,
    env: {
      ...process.env,
      PSModulePath: path.join(path.dirname(executable), 'Modules'),
      LSSH_NATIVE_SOURCE: Buffer.from(NATIVE_SOURCE, 'utf8').toString('base64'),
      LSSH_PERMISSION_REQUEST: JSON.stringify(request)
    }
    });
  } finally { release(); }
}
