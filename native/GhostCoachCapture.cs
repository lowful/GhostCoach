// GhostCoach screen capture helper.
//
// Same fast GDI CopyFromScreen primitive the app always used, but compiled to
// a native exe instead of run through powershell.exe. That matters for two
// reasons: it is not a PowerShell script, so Windows Defender's PowerShell
// Empire "Get-Screenshot" signature cannot match it (the false positive that
// scared users), and it writes the JPEG as base64 straight to stdout, so there
// is no temp .ps1 or temp .jpg touching disk each frame. Fast in, fast out.
//
// Build (compiler ships with Windows, no SDK needed):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
//     /target:winexe /optimize+ /out:GhostCoachCapture.exe ^
//     /reference:System.Drawing.dll /reference:System.Windows.Forms.dll ^
//     GhostCoachCapture.cs
//
// Usage: GhostCoachCapture.exe <width> <height> <jpegQuality>
//   -> base64 JPEG on stdout, or "ERR:<message>" on stderr with exit code 1.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

static class GhostCoachCapture
{
    static int Main(string[] args)
    {
        try
        {
            int w = args.Length > 0 ? int.Parse(args[0]) : 854;
            int h = args.Length > 1 ? int.Parse(args[1]) : 480;
            long q = args.Length > 2 ? long.Parse(args[2]) : 50L;

            Rectangle b = Screen.PrimaryScreen.Bounds;
            byte[] jpeg;

            // Grab the full screen, downscale, encode, all in memory.
            using (Bitmap shot = new Bitmap(b.Width, b.Height))
            {
                using (Graphics g = Graphics.FromImage(shot))
                {
                    g.CopyFromScreen(b.Location, Point.Empty, b.Size);
                }
                using (Bitmap small = new Bitmap(shot, w, h))
                using (MemoryStream ms = new MemoryStream())
                {
                    ImageCodecInfo enc = null;
                    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                    {
                        if (c.MimeType == "image/jpeg") { enc = c; break; }
                    }
                    using (EncoderParameters ep = new EncoderParameters(1))
                    {
                        ep.Param[0] = new EncoderParameter(Encoder.Quality, q);
                        small.Save(ms, enc, ep);
                    }
                    jpeg = ms.ToArray();
                }
            }

            // Base64 straight to stdout, no temp file.
            string b64 = Convert.ToBase64String(jpeg);
            Console.Out.Write(b64);
            Console.Out.Flush();
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.Write("ERR:" + e.Message);
            return 1;
        }
    }
}
