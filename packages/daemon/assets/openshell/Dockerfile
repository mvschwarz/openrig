# Supply a digest-pinned base with Python3 and Node22+, and a trusted Claude Code 2.1.310 binary.
# No credentials, histories or work payloads belong in this build context.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0
COPY --chmod=0755 claude /usr/local/bin/claude
COPY --chmod=0644 guest.py /opt/openrig/guest.py
RUN python3 --version && node --version && /usr/local/bin/claude --version \
    && mkdir -p /sandbox/openrig/control /sandbox/openrig/work/artifacts /sandbox/openrig/native \
    && chown -R 1000:1000 /sandbox/openrig
USER 1000:1000
WORKDIR /sandbox/openrig/work
ENV CLAUDE_CONFIG_DIR=/sandbox/openrig/native
ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENTRYPOINT ["python3", "/opt/openrig/guest.py"]
