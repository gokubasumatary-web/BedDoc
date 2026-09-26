#!/bin/bash
# Deploy BedDoc to the Raspberry Pi and restart the service.
# Run from the project root:  bash deploy/deploy.sh
set -e

PI=pi@100.83.213.24
DEST=/home/pi/BedDoc

ssh $PI "mkdir -p $DEST/config $DEST/models"
scp -r backend frontend requirements.txt $PI:$DEST/
scp deploy/beddoc.service $PI:/tmp/beddoc.service
ssh $PI "sudo mv /tmp/beddoc.service /etc/systemd/system/beddoc.service \
      && sudo systemctl daemon-reload && sudo systemctl restart beddoc"
echo "Deployed and restarted"
