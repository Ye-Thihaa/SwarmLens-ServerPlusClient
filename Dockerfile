FROM python:3.12-slim
WORKDIR /app

# OpenCV's shared-library dependencies. requirements.txt deliberately pins
# the *headless* OpenCV build precisely so these wouldn't be needed -- but
# mediapipe declares a hard dependency on `opencv-contrib-python` (the GUI
# build), so pip installs both, and the GUI one ends up providing the `cv2`
# module. That build links against libGL/libglib/libxcb, none of which ship
# in python:3.12-slim, so `import cv2` -- and therefore `import ai_engine`,
# and therefore the whole app -- dies at startup with
# `ImportError: libxcb.so.1: cannot open shared object file`.
#
# This only bites in the container: the Windows wheels used for local
# development bundle their own dependencies, so a manual `uvicorn` run
# never sees it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libxcb1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Shell form so ${PORT} and ${HOST} expand at runtime. Render (and most
# PaaS) assign a port through $PORT and expect the process to bind it; a
# hardcoded 8000 gets the service marked unhealthy and cycled forever.
# Defaults to 8000 so docker-compose.yml -- which maps 8001:8000 and sets
# no PORT -- is unaffected.
#
# HOST exists for Fly.io, whose private network between machines (6PN) is
# IPv6-only. A process bound to 0.0.0.0 listens on IPv4 only, so its public
# health check passes while every peer's gossip and raft RPC is refused --
# which reads as three healthy nodes that will not form a cluster.
#
# HOST=:: is IPv6-ONLY, not dual-stack -- measured, and the opposite of what
# the kernel setting suggests. The container reports bindv6only=0, but
# uvicorn creates the socket with IPV6_V6ONLY set, so IPv4 is refused
# outright: from inside a HOST=:: container, connecting to ::1 succeeds and
# 127.0.0.1 is refused. Two consequences. On Fly it is correct and required,
# since all peer traffic is IPv6 (verified on an IPv6-only docker network:
# peers reachable, leader elected, events gossiped, and blob bytes
# replicated). Locally it means a HOST=:: container is unreachable through
# docker's IPv4 port mapping -- so don't set it for local runs and conclude
# the image is broken.
#
# Hence the default stays 0.0.0.0: it is what every non-Fly deployment
# wants, and a container with IPv6 disabled cannot bind :: at all.
CMD uvicorn main:app --host ${HOST:-0.0.0.0} --port ${PORT:-8000}
