# Kernel-parity torture fixture: bindings (attrpath + expression), curried
# function_expression params, inherit / inherit_from, direct import,
# builtins.import, callPackage chains, and imports/modules list paths.
{ pkgs, lib ? pkgs.lib, ... }:

let
  topLevel = 42;
  helper = a: b: a + b;
  curried = a: b: c: a + b + c;
  single = x: x + 1;
  patterned = { a, b }@args: a + b;

  hardware = import ./hardware.nix;
  other = builtins.import ./other.nix;
  pkg = pkgs.callPackage ./pkg.nix { };
  tools = pkgs.callPackages ../tools { };
  chained = pkgs.callPackage ./chained.nix { } ./extra.nix;

  returned = {
    inner = 1;
    deep = { leaf = helper 1 2; };
  };
in
{
  inherit topLevel;
  inherit (pkgs) stdenv fetchurl;

  imports = [
    ./modules/a.nix
    ../modules/b.nix
  ];
  modules = [ ./modules/c.nix ];

  config = {
    nested.value = single 1;
    dynamic = import (./dynamic.nix);
    quoted = import "./quoted.nix";
    interpolated = import "${./interpolated.nix}";
    applied = curried 1 2 3;
    withPattern = patterned { a = 1; b = 2; };
  };

  services.foo.enable = true;
  exported = returned;
}