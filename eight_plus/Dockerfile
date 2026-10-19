ARG BUILD_FROM
FROM ${BUILD_FROM}

# Everything is Python standard library — the only extra is the SSH client for the optional
# "straight from the Pod" sleep-data source.
RUN apk add --no-cache python3 openssh-client

COPY app /app
ENV CONFIG_DIR=/homeassistant DATA_DIR=/data PYTHONUNBUFFERED=1
CMD ["python3", "/app/main.py"]
