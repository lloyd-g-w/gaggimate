{
  description = "GaggiMate development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        pythonEnv = pkgs.python3.withPackages (
          ps: with ps; [
            grpcio
            grpcio-tools
            protobuf
          ]
        );

        fhs = pkgs.buildFHSEnv {
          name = "gaggimate-dev";

          targetPkgs =
            pkgs:
            with pkgs;
            [
              bashInteractive
              cacert
              clang-tools
              gcc
              git
              gzip
              libusb1
              ncurses
              ncurses5
              nodejs_22
              openssl
              platformio
              pythonEnv
              stdenv.cc.cc.lib
              udev
              zlib
            ];

          profile = ''
            export PLATFORMIO_CORE_DIR=''${PLATFORMIO_CORE_DIR:-$PWD/.platformio}
            export PLATFORMIO_GLOBALLIB_DIR=''${PLATFORMIO_GLOBALLIB_DIR:-$PLATFORMIO_CORE_DIR/lib}
            export PLATFORMIO_PYTHON_EXE=''${PLATFORMIO_PYTHON_EXE:-$PLATFORMIO_CORE_DIR/penv/bin/python}
            export PLATFORMIO_SETTING_ENABLE_TELEMETRY=no
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            export GIT_SSL_CAINFO=$SSL_CERT_FILE
            export PATH="$PWD/web/node_modules/.bin:$PATH"
            export PYTHONPATH="${pythonEnv}/${pythonEnv.sitePackages}:''${PYTHONPATH:-}"

            if [ ! -x "$PLATFORMIO_PYTHON_EXE" ]; then
              mkdir -p "$PLATFORMIO_CORE_DIR"
              ${pythonEnv}/bin/python3 -m venv "$PLATFORMIO_CORE_DIR/penv"
            fi
          '';

          runScript = "bash";
        };

        nativePackages = with pkgs; [
          clang-tools
          gcc
          git
          gzip
          nodejs_22
          platformio
          pythonEnv
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          packages = nativePackages ++ [ fhs ];

          shellHook = ''
            export PLATFORMIO_CORE_DIR=''${PLATFORMIO_CORE_DIR:-$PWD/.platformio}
            export PLATFORMIO_GLOBALLIB_DIR=''${PLATFORMIO_GLOBALLIB_DIR:-$PLATFORMIO_CORE_DIR/lib}
            export PLATFORMIO_PYTHON_EXE=''${PLATFORMIO_PYTHON_EXE:-$PLATFORMIO_CORE_DIR/penv/bin/python}
            export PLATFORMIO_SETTING_ENABLE_TELEMETRY=no
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            export GIT_SSL_CAINFO=$SSL_CERT_FILE
            export PATH="$PWD/web/node_modules/.bin:$PATH"
            export PYTHONPATH="${pythonEnv}/${pythonEnv.sitePackages}:''${PYTHONPATH:-}"

            if [ ! -x "$PLATFORMIO_PYTHON_EXE" ]; then
              mkdir -p "$PLATFORMIO_CORE_DIR"
              ${pythonEnv}/bin/python3 -m venv "$PLATFORMIO_CORE_DIR/penv"
            fi

            alias gaggimate-fhs='${fhs}/bin/gaggimate-dev'
          '';
        };

        packages.default = fhs;
      }
    );
}
