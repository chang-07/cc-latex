class CcLatex < Formula
  desc "Typeset LaTeX inline in Claude Code replies"
  homepage "https://github.com/chang-07/cc-latex"
  url "https://github.com/chang-07/cc-latex/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "b91e973d10338d7d31afe82ef843c4adb48d3e92da49c3358316f4748e1def17"
  head "https://github.com/chang-07/cc-latex.git", branch: "main"

  depends_on :macos # the mod re-saves each image with sips
  depends_on "poppler"
  depends_on "tectonic"

  def install
    libexec.install "latex-render", "scripts"

    # `cc-latex install` adds the mod to ~/.claude/settings.json. It names the
    # mod by its opt path, which stays the same across upgrades.
    (bin/"cc-latex").write <<~SH
      #!/bin/sh
      export CC_LATEX_MOD="#{opt_libexec}/latex-render"
      case "${1:-}" in
        install) exec "#{opt_libexec}/scripts/install.sh" ;;
        remove|uninstall) exec "#{opt_libexec}/scripts/install.sh" --remove ;;
        *)
          echo "usage: cc-latex install   add the mod to every Claude Code session"
          echo "       cc-latex remove    take it out again"
          [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || exit 1
          ;;
      esac
    SH

    # Runs Claude Code under tmux with working inline images.
    (bin/"cc-tmux-bridge").write <<~SH
      #!/bin/sh
      exec python3 "#{opt_libexec}/scripts/cc-tmux-bridge.py" "$@"
    SH
    chmod 0755, [bin/"cc-latex", bin/"cc-tmux-bridge", libexec/"scripts/install.sh"]
  end

  def caveats
    <<~EOS
      To turn the mod on for every Claude Code session, run once:
        cc-latex install

      Then start a new session and ask for some math.

      Inside tmux, run Claude Code through the bridge so images reach the terminal:
        tmux set -g allow-passthrough all
        cc-tmux-bridge claude

      Before `brew uninstall cc-latex`, run `cc-latex remove`.
    EOS
  end

  test do
    assert_match "cc-latex install", shell_output("#{bin}/cc-latex --help")
    assert_path_exists libexec/"latex-render/hooks/hooks.json"
  end
end
