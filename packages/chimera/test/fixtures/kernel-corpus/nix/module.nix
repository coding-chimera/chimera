# Second kernel-parity fixture: nested attrsets / let bodies, inherit_from,
# mkIf-wrapped imports, parenthesized and dynamic import arguments, and
# callPackage inside a list.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.demo;
  inherit (lib) mkEnableOption mkIf;
  makePath = name: ./packages + "/${name}.nix";
  wrapped = x: y: z: { inherit x y z; };
  inner = let
    local = 1;
  in {
    value = local;
    fn = a: a + local;
  };
in
{
  options.services.demo = {
    enable = mkEnableOption "demo";
  };

  config = mkIf cfg.enable {
    imports = [
      (./modules/paren.nix)
      ./modules/plain.nix
      (import ./modules/imported.nix)
      (pkgs.callPackage ./modules/called.nix { })
      makePath "dynamic"
    ];

    systemd.services.demo = {
      serviceConfig.ExecStart = "${pkgs.hello}/bin/hello";
      script = ''
        echo ${toString (1 + 2)}
      '';
    };

    nested.a.b.c = wrapped 1 2 3;
    inherited = inner;
  };
}